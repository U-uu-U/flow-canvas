import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { topoOrder, getPorts } from '../src/graph-model.js';
import { expandGenerationPrompts } from '../src/node-types.js';
import { bindReferenceCitations, withoutReferenceCitationGuide } from '../src/reference-citations.js';
import { getGeneratorResultEntries, appendGeneratorResult } from '../src/generator-result-stack.js';
import { resolveImageDimensions, resolveGenerationDisplaySize, inferClosestAspectRatio } from '../src/image-node-settings.js';
import { inferProviderCapability, isMidjourneyImageModel } from '../src/provider-capabilities.js';
import { imageGenerationRequestParams, normalizeVideoGenerationResolution } from '../src/generation-request-params.js';
import { getVideoModelProfile } from '../shared/video-model-profiles.mjs';
import { DEFAULT_MODEL_CONFIG } from '../src/model-config-default.js';
import { resolveModelConfigEntry, toVideoProfileOverrides, mergeVideoProfile, validateModelRequest } from '../src/model-config-capabilities.js';
import adapters from './video-provider-adapters.js';
import { mediaKind } from './agent-media.cjs';

const copy = value => JSON.parse(JSON.stringify(value));
const IMAGE_RATIOS = ['adaptive', '1:1', '16:9', '9:16', '4:3', '3:4'];
const isMidjourney = provider => isMidjourneyImageModel(provider.model);

function optionValues(option, fallback) {
    if (['tier', 'enum'].includes(option?.type)) return [...(option.allowAuto ? ['adaptive'] : []), ...(option.values || [])];
    if (option?.type === 'fixed') return [option.value];
    if (option?.type === 'unsupported') return [];
    return fallback;
}

function catalogOptions(candidates, field, fallback) {
    const values = candidates.map(entry => optionValues(entry.options?.[field], fallback));
    return values.length ? [...new Set(values.flat())] : fallback;
}

function catalogReferenceLimits(candidates, fallback) {
    if (!candidates.length) return fallback;
    const limits = {};
    for (const [kind, key] of Object.entries({ image: 'referenceImages', video: 'referenceVideos', audio: 'referenceAudios' })) {
        const values = candidates.map(entry => {
            const capability = entry.capabilities?.[key];
            return capability?.supported === false ? 0 : capability?.supported === true ? capability.max : fallback?.[kind];
        });
        if (values.every(Number.isFinite)) limits[kind] = Math.max(...values);
    }
    return Object.keys(limits).length ? limits : undefined;
}

function requestSize(config, references) {
    const first = references.find(reference => reference.kind === 'image');
    const size = resolveImageDimensions(config.resolutionTier || '2K', config.ratio || 'adaptive', first || {});
    return config.size || `${size.width}x${size.height}`;
}
function bindAgentReferences(config, references, connections) {
    const images = references.filter(reference => reference.kind === 'image')
        .map(reference => ({ ...reference, filePath: reference.filePath || `pending:${reference.nodeId}` }));
    const files = [...new Set(images.map(reference => reference.filePath))].map(filePath => ({ filePath }));
    return bindReferenceCitations(config, files, images.map(reference => ({
        connectionId: connections.find(connection => connection.from.nodeId === reference.nodeId)?.id,
        source: { id: reference.nodeId, filePath: reference.filePath }
    })));
}
const error = (code, message) => Object.assign(new Error(message), { code });
const fingerprint = (node, connections) => crypto.createHash('sha256').update(JSON.stringify({
    id: node.id, kind: node.kind, nodeType: node.nodeType, config: node.config,
    filePath: node.filePath,
    primaryResult: getGeneratorResultEntries(node)[0]?.filePath || null,
    generation: node.kind === 'op' ? undefined : node.generation,
    inputs: connections.filter(c => c.to.nodeId === node.id && c.kind !== 'history')
})).digest('hex');

export class AgentGeneration {
    constructor({ board, bridge, loadConfig, fallbackDir, loadModelConfig = () => DEFAULT_MODEL_CONFIG, refreshModelConfig }) {
        Object.assign(this, { board, bridge, loadConfig, fallbackDir, loadModelConfig, refreshModelConfig });
    }
    _capabilities(provider, kind, modelConfig) {
        const resolution = resolveModelConfigEntry(modelConfig, { ...provider, kind });
        const candidates = resolution.ambiguous ? resolution.candidates : [resolution.entry].filter(Boolean);
        const profile = kind === 'video'
            ? mergeVideoProfile(getVideoModelProfile(provider), toVideoProfileOverrides(modelConfig, resolution.entry)) : null;
        return { ...resolution, candidates, profile };
    }
    _assertRequest(modelConfig, provider, kind, config, prompt, references, body) {
        const counts = {};
        for (const kind of ['image', 'video', 'audio']) {
            const refs = references.filter(ref => ref.kind === kind);
            const unique = kind === 'image' ? [...new Map(refs.map(ref => [ref.filePath || ref.nodeId, ref])).values()] : refs;
            counts[kind] = { count: unique.length, maxBytes: unique.reduce((max, ref) =>
                Math.max(max, ref.filePath ? fs.statSync(ref.filePath).size : 0), 0) };
        }
        const imageParams = kind === 'image' ? imageGenerationRequestParams({ ...config,
            size: requestSize(config, references), midjourneyRepeat: 1 }, provider.model) : null;
        const fields = kind === 'video'
            ? { ...config, resolutionTier: body?.resolution ?? config.resolution, ratio: body?.ratio ?? config.ratio, duration: body?.duration ?? config.duration }
            : { ...config, resolutionTier: config.resolutionTier, quality: imageParams.quality, n: 1 };
        if (imageParams?.midjourney) {
            Object.assign(fields, imageParams.midjourney);
            if (fields.quality === 'default') delete fields.quality;
        }
        const features = { ...config };
        for (const field of ['generateAudio', 'cameraFixed', 'watermark', 'webSearch']) {
            features[field] = kind === 'image' && field === 'webSearch'
                ? imageParams.webSearch === true : Boolean(body ? body[field] : config[field]);
        }
        const check = fields => validateModelRequest({ config: modelConfig, provider: { ...provider, kind },
            fields, features, references: counts, prompt });
        const results = [check(fields)];
        if (kind === 'image') results.push(check({ ...fields, resolutionTier: body?.size || imageParams.size }));
        for (const result of results) {
            if (result.ok) continue;
            const issue = result.errors[0];
            const code = { duration: 'INVALID_DURATION', resolutionTier: 'INVALID_RESOLUTION', ratio: 'INVALID_RATIO',
                referenceImages: 'REFERENCE_LIMIT', referenceVideos: 'REFERENCE_LIMIT', referenceAudios: 'REFERENCE_LIMIT' }[issue.field]
                || (issue.code === 'FEATURE_UNSUPPORTED' ? 'UNSUPPORTED_PARAMETER' : issue.code);
            throw Object.assign(error(code, `当前模型 CONFIG 不支持此请求：${result.errors.map(item => item.message).join('；')}`),
                { issues: result.errors, warnings: result.warnings });
        }
        // This wire format has only sd/hd. Never acknowledge 4K and send sd.
        if (kind === 'image' && isMidjourney(provider) && !['1K', '2K'].includes(config.resolutionTier)) {
            throw error('INVALID_RESOLUTION', 'Midjourney 的 definition 无法编码该画质，请使用 1K 或 2K');
        }
    }
    providers() {
        const config = this.loadConfig();
        return (config.providers || []).flatMap(provider => [...new Set(provider.models || [provider.model])].filter(Boolean)
            .map((model, index) => ({ ...provider, model, sourceProviderId: provider.id,
                id: index ? `${provider.id}::model:${encodeURIComponent(model)}` : provider.id })));
    }
    resolveProvider(binding = {}, kind = 'text') {
        const config = this.loadConfig();
        const id = binding.providerId || binding.id || binding.sourceProviderId || config.globalConfig?.[`${kind}ProviderId`];
        const list = this.providers().filter(p => inferProviderCapability(p) === kind);
        let provider = list.find(p => p.id === id && (!binding.model || p.model === binding.model))
            || list.find(p => p.sourceProviderId === (binding.sourceProviderId || id) && (!binding.model || p.model === binding.model));
        if (!provider && binding.model && !id) provider = list.find(p => p.model === binding.model);
        if (!provider && !id && !binding.model) provider = list[0];
        if (!provider?.apiKey) throw error('PROVIDER_REQUIRED', `未找到可用的 ${kind} 模型，请在设置中选择模型`);
        return provider;
    }
    listModels(modelConfig = this.loadModelConfig()) {
        return this.providers().filter(p => inferProviderCapability(p) !== 'text').map(p => {
            const kind = inferProviderCapability(p);
            const { profile, candidates, matched, ambiguous } = this._capabilities(p, kind, modelConfig);
            const price = profile?.price?.kind === 'sale' ? profile.price : null;
            return { id: p.id, model: p.model, kind, name: p.name,
                ratios: catalogOptions(candidates, 'ratio', profile?.ratios || IMAGE_RATIOS),
                resolutions: catalogOptions(candidates, 'resolutionTier', profile?.resolutions || (isMidjourney(p) ? ['1K', '2K'] : ['1K', '2K', '4K'])),
                durations: kind === 'video' ? [...new Set(candidates.length ? candidates.flatMap(entry =>
                    toVideoProfileOverrides(modelConfig, entry)?.durations ?? profile?.durations ?? []) : profile?.durations || [])] : undefined,
                referenceLimits: catalogReferenceLimits(candidates, profile?.referenceLimits), price,
                modelConfig: { revision: modelConfig.revision, matched, ambiguous, candidates: copy(candidates) },
                pricingStatus: price ? 'configured_sale' : 'unknown' };
        });
    }
    prepare(run, input, modelConfig = this.loadModelConfig()) {
        const project = this.board.readProject(run.projectId);
        const ids = input?.nodeIds;
        if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => typeof id !== 'string')) throw error('INVALID_ARGUMENTS', '每批次请选择 1 到 20 个生成节点');
        const nodes = new Map(project.items.map(node => [node.id, node]));
        const order = [], targets = new Set(ids);
        for (const id of ids) {
            const sorted = topoOrder(id, project.items, project.connections);
            if (sorted.cyclic || sorted.missing.length || !sorted.order.length) throw error('INVALID_GRAPH', '节点依赖存在环或缺失，请先修复连线');
            for (const nodeId of sorted.order) if (!order.includes(nodeId)) order.push(nodeId);
        }
        const steps = [];
        const texts = new Map();
        const nodeFingerprints = Object.fromEntries(order.map(id => [id, fingerprint(nodes.get(id), project.connections)]));
        for (const id of order) {
            const node = nodes.get(id);
            const inputs = project.connections.filter(c => c.kind !== 'history' && c.to.nodeId === id).map(c => nodes.get(c.from.nodeId));
            const upstreamText = inputs.map(n => texts.get(n.id)).filter(Boolean).flat();
            if (node.kind === 'op' && node.nodeType === 'text') {
                if (node.config?.useAi || node.config?.useAI) throw error('TEXT_AI_NOT_PLANNED', '请先让 Agent 填写文本节点内容，再生成媒体；此批次不隐式调用文字生成节点');
                const separator = node.config?.separator === '' ? '\n' : node.config?.separator ?? '\n';
                const joined = [...upstreamText, node.config?.text || node.config?.prompt || ''].filter(Boolean).join(separator);
                texts.set(id, node.config?.splitBy ? joined.split(node.config.splitBy).map(text => text.trim()).filter(Boolean) : joined);
                continue;
            }
            if (node.kind !== 'op' || !['image', 'video'].includes(node.nodeType)) {
                if (targets.has(id)) throw error('GENERATOR_REQUIRED', '请从素材新建并连接生成节点，原素材会保留');
                continue;
            }
            if (!targets.has(id) && this._pathFor(node)) continue;
            let config = copy(node.config || {});
            if (node.id === run.source?.nodeId) Object.assign(config, run.source.parameters || {});
            // The orchestrator has already compiled the image intent into the node prompt.
            const count = Number(config.count ?? 1);
            if (!Number.isInteger(count) || count < 1 || count > 8) throw error('COUNT_LIMIT', '单节点每批次需要 1 到 8 次生成');
            const provider = this.resolveProvider(config, node.nodeType);
            if (Number(config.midjourneyRepeat || 1) > 1)
                throw error('COUNT_LIMIT', 'Agent 批次请使用生成数量，不使用额外的 Midjourney repeat');
            const { profile, entry } = this._capabilities(provider, node.nodeType, modelConfig);
            if (profile) {
                config.duration = Number(config.duration ?? profile.defaultDuration ?? 5);
                config.resolution ||= profile.defaultResolution;
                config.resolution = normalizeVideoGenerationResolution(provider.model, config.resolution);
                config.ratio ||= profile.defaultRatio;
            } else {
                const option = entry?.options?.resolutionTier;
                config.resolutionTier ||= option?.default ?? optionValues(option, [isMidjourney(provider) ? '1K' : '2K'])[0];
            }
            const references = inputs.filter(n => !texts.has(n.id)).map(n => ({ nodeId: n.id, filePath: steps.some(step => step.nodeId === n.id) ? '' : this._pathFor(n),
                kind: n.kind === 'op' ? n.nodeType : n.mediaType || mediaKind(n.filePath || ''), width: n.width, height: n.height }));
            config = bindAgentReferences(config, references, project.connections.filter(c => c.kind !== 'history' && c.to.nodeId === id)).config;
            if (upstreamText.length) config.generationUpstreamPrompts = upstreamText;
            const prompts = expandGenerationPrompts({ prompt: upstreamText }, { ...config, count });
            if (!prompts.length) throw error('PROMPT_REQUIRED', '生成节点缺少提示词');
            if (prompts.length > 8) throw error('COUNT_LIMIT', '单节点每批次最多 8 次生成');
            for (const reference of references) if (reference.filePath) {
                if (!fs.existsSync(reference.filePath)) throw error('REFERENCE_MISSING', '参考素材已断联，请先修补');
                const stat = fs.statSync(reference.filePath);
                reference.fileFingerprint = `${stat.size}:${stat.mtimeMs}`;
            }
            const price = profile?.price?.kind === 'sale' ? copy(profile.price) : null;
            for (const prompt of prompts) this._assertRequest(modelConfig, provider, node.nodeType, config, prompt, references);
            for (const [index, prompt] of prompts.entries()) steps.push({ id: `step-${crypto.randomUUID()}`, nodeId: id,
                title: `${node.title || node.nodeType} ${index + 1}/${prompts.length}`, model: provider.model, kind: node.nodeType,
                count: 1, prompt, originalPrompt: config.prompt || '', config, price, references,
                providerRef: { id: provider.id, model: provider.model, endpoint: provider.endpoint, type: provider.type }, nodeFingerprints,
                width: node.width || 320, height: node.height || 320, x: node.x || 0, y: node.y || 0 });
        }
        if (!steps.length || steps.length > 20) throw error('BATCH_LIMIT', '每批次需要 1 到 20 次媒体生成');
        const currencies = new Set(steps.map(s => s.price?.currency).filter(Boolean));
        const priceKnown = steps.every(s => s.price?.unit === 'request') && currencies.size === 1;
        return { summary: String(input.summary || '生成所选节点'), steps, priceKnown,
            estimatedCost: priceKnown ? steps.reduce((sum, step) => sum + step.price.amount, 0) : null,
            currency: priceKnown ? [...currencies][0] : null };
    }
    _pathFor(node) { return getGeneratorResultEntries(node)[0]?.filePath || node.filePath || ''; }
    _wireNext(run, step, filePaths) {
        for (const next of run.steps) for (const ref of next.references) if (ref.nodeId === step.nodeId && !ref.filePath) ref.filePath = filePaths[0];
    }
    _validate(step, project) {
        for (const [id, expected] of Object.entries(step.nodeFingerprints)) {
            const node = project.items.find(n => n.id === id);
            if (!node || fingerprint(node, project.connections) !== expected) throw error('SOURCE_CHANGED', '源节点或依赖已修改，请更新计划后重新确认');
        }
    }
    async execute(step, run, { signal, resume, checkpoint }) {
        const project = this.board.readProject(run.projectId);
        this._validate(step, project);
        const outputId = `result-${step.id}`;
        const existing = project.items.find(n => n.id === outputId);
        const hasExistingOutput = existing?.filePath && fs.existsSync(existing.filePath);
        const downloaded = step.filePaths?.length && step.filePaths.every(filePath => fs.existsSync(filePath));
        const recovering = Boolean(resume || step.remoteTaskId);
        const submitting = !hasExistingOutput && !downloaded && !recovering;
        // Completed or submitted work does not need the renderer or today's model limits.
        const modelConfig = submitting
            ? (this.refreshModelConfig ? await this.refreshModelConfig() : this.loadModelConfig()) : null;
        const provider = this.resolveProvider(step.providerRef, step.kind);
        if ((step.providerRef.endpoint && provider.endpoint !== step.providerRef.endpoint)
            || (step.providerRef.type && provider.type !== step.providerRef.type)) throw error('PROVIDER_CHANGED', 'API 路线已变更，请重新确认计划');
        const references = step.references.map(ref => {
            const source = project.items.find(n => n.id === ref.nodeId);
            const filePath = ref.filePath || this._pathFor(source);
            if (!filePath || !fs.existsSync(filePath)) throw error('REFERENCE_MISSING', '上游尚未生成或参考文件已断联');
            const stat = fs.statSync(filePath);
            if (ref.fileFingerprint && ref.fileFingerprint !== `${stat.size}:${stat.mtimeMs}`) throw error('SOURCE_CHANGED', '参考文件内容已变化，请重新确认');
            return { ...ref, filePath };
        });
        const config = { ...step.config };
        if (step.kind === 'video') config.resolution = normalizeVideoGenerationResolution(provider.model, config.resolution);
        const outputReferences = references.map(reference => {
            const generatedSource = run.results?.find(result => result.sourceNodeId === reference.nodeId && result.filePaths?.includes(reference.filePath));
            return { ...reference, nodeId: generatedSource?.nodeIds?.[0] || reference.nodeId };
        });
        const draft = copy(config);
        if (step.nodeId === run.source?.nodeId && typeof run.source.prompt === 'string') draft.prompt = run.source.prompt;
        for (const occurrence of draft.referenceCitationOccurrences || []) {
            const index = references.findIndex(reference => reference.nodeId === occurrence.sourceNodeId);
            if (index >= 0) occurrence.sourceNodeId = outputReferences[index].nodeId;
        }
        const bound = bindAgentReferences(draft, outputReferences,
            project.connections.filter(connection => connection.kind !== 'history' && connection.to.nodeId === step.nodeId));
        const promptDraftConfig = bound.config;
        const userPrompt = step.nodeId === run.source?.nodeId
            ? run.source.effectivePrompt || run.source.prompt || withoutReferenceCitationGuide(step.prompt, config)
            : withoutReferenceCitationGuide(step.prompt, config);
        const first = references.find(r => r.kind === 'image');
        const profile = modelConfig ? this._capabilities(provider, step.kind, modelConfig).profile
            : (step.kind === 'video' ? getVideoModelProfile(provider) : null);
        const ratio = !config.ratio || config.ratio === 'adaptive' ? inferClosestAspectRatio(first?.width, first?.height,
            step.kind === 'video' ? (profile?.ratios || []).filter(r => r !== 'adaptive') : IMAGE_RATIOS, '16:9') : config.ratio;
        const dimensions = resolveImageDimensions(config.resolutionTier || '2K', config.ratio || 'adaptive', first || {});
        const targetDir = path.join(project.defaultSaveFolder || this.fallbackDir, 'FlowCanvas-Agent', crypto.createHash('sha256').update(String(run.projectId)).digest('hex').slice(0, 12));
        if (hasExistingOutput) {
            const filePaths = getGeneratorResultEntries(existing).map(entry => entry.filePath).filter(Boolean);
            if (!filePaths.length) filePaths.push(existing.filePath);
            this._wireNext(run, step, filePaths);
            return { nodeIds: [existing.id], filePaths, sourceNodeId: step.nodeId, reused: true };
        }
        if (submitting) this._assertRequest(modelConfig, provider, step.kind, config, step.prompt, references);
        if (existing) await this.board.updateProject(run.projectId, current => {
            this._validate(step, current);
            const output = current.items.find(node => node.id === outputId);
            if (!output) throw error('OUTPUT_REMOVED', '生成占位节点已删除');
            output.runStatus = 'running';
            output.runError = '';
            output.runStartedAt ||= Date.now();
        });
        if (!existing) await this.board.updateProject(run.projectId, current => {
            this._validate(step, current);
            const display = resolveGenerationDisplaySize({ kind: step.kind, referenceSize: first, ratio, size: `${dimensions.width}x${dimensions.height}` });
            current.items.push({ id: outputId, kind: 'op', nodeType: step.kind, title: step.title,
                x: step.x + step.width + 64, y: step.y + run.steps.indexOf(step) * (step.height + 48),
                width: first?.width || display.width || step.width, height: first?.height || display.height || step.height,
                config: { ...promptDraftConfig, count: 1, model: step.model }, runStatus: 'running',
                runStartedAt: Date.now(),
                metadata: { agentRunId: run.id, agentStepId: step.id } });
            const parent = current.items.find(node => node.id === step.nodeId);
            current.connections.push({ id: `history-${step.id}`, kind: 'history',
                from: { nodeId: step.nodeId, port: getPorts(parent).outputs[0]?.name || step.kind }, to: { nodeId: outputId, port: 'source' } });
            outputReferences.forEach((reference, index) => {
                const sourceId = reference.nodeId;
                const source = current.items.find(node => node.id === sourceId);
                if (source) current.connections.push({ id: `reference-${step.id}-${index}`, kind: 'flow',
                    from: { nodeId: sourceId, port: getPorts(source).outputs[0]?.name || 'source' }, to: { nodeId: outputId, port: 'source' } });
            });
        });
        const body = { ...config, count: 1, n: 1,
            provider: step.kind === 'video' ? 'openai-video' : 'openai', providerConfig: provider,
            noSubmissionRetry: true, requestId: step.id,
            clientTaskId: step.id, prompt: step.prompt, targetDir, addToCanvas: false,
            promptDraftConfig, referenceBindings: bound.bindings, userPrompt,
            projectId: run.projectId, nodeId: outputId,
            sourceReferences: bound.bindings.map(r => ({ filePath: r.filePath })),
            videoReferences: references.filter(r => r.kind === 'video').map(r => ({ filePath: r.filePath })),
            audioReferences: references.filter(r => r.kind === 'audio').map(r => ({ filePath: r.filePath })),
            size: requestSize(config, references), quality: config.quality || 'high',
            responseFormat: config.responseFormat || 'url', ratio, resolution: config.resolution, duration: config.duration,
            generateAudio: !!config.generateAudio, cameraFixed: !!config.cameraFixed, watermark: !!config.watermark, webSearch: !!config.webSearch };
        if (step.kind === 'image') Object.assign(body, imageGenerationRequestParams({ ...config,
            size: body.size, midjourneyRepeat: 1 }, provider.model, outputId));
        if (submitting && step.kind === 'video' && adapters.isSeedance25Model(provider.model)) adapters.buildSeedance25RequestBody({ model: provider.model, prompt: step.prompt,
            duration: config.duration, resolution: config.resolution, aspectRatio: ratio, referenceImages: body.sourceReferences.map(r => r.filePath) });
        if (signal?.aborted) throw error('CANCELED', '已停止');
        const abort = () => this.bridge.cancelGenerationFromRenderer(step.id);
        signal?.addEventListener('abort', abort, { once: true });
        let result;
        try {
            if (downloaded) {
                result = { filePaths: step.filePaths, taskId: step.remoteTaskId, mediaType: step.kind };
            } else if (recovering) {
                if (!step.remoteTaskId) throw error('SUBMISSION_UNKNOWN', '缺少上游任务 ID，不会重复提交');
                result = await (step.kind === 'video' ? this.bridge.resumeVideoFromRenderer({ ...body, taskId: step.remoteTaskId })
                    : this.bridge.resumeImageFromRenderer({ ...body, taskId: step.remoteTaskId }));
            } else {
                // Board writes and reference preparation can await. Re-read immediately before submission.
                const latestConfig = this.refreshModelConfig ? await this.refreshModelConfig() : this.loadModelConfig();
                this._assertRequest(latestConfig, provider, step.kind, config, body.prompt, references, body);
                if (signal?.aborted) throw error('CANCELED', '已停止');
                checkpoint({ status: 'submitting' });
                result = await (step.kind === 'video' ? this.bridge.generateVideoFromRenderer(body) : this.bridge.generateImageFromRenderer(body));
            }
        } finally { signal?.removeEventListener('abort', abort); }
        if (signal?.aborted) throw error('CANCELED', '已停止，迟到产物未写入画布');
        const filePaths = (result.filePaths?.length ? result.filePaths : [result.filePath]).filter(Boolean);
        if (!filePaths.length) throw error('NO_RESULT', '接口没有返回已保存的媒体文件');
        checkpoint({ filePaths, remoteTaskId: result.taskId || step.remoteTaskId, status: 'downloaded' });
        await this.board.updateProject(run.projectId, current => {
            this._validate(step, current);
            const output = current.items.find(n => n.id === outputId);
            if (!output) throw error('OUTPUT_REMOVED', '生成占位节点已删除；结果文件已保留');
            output.runStatus = 'done';
            output.filePath = filePaths[0];
            output.mediaType = result.mediaType || step.kind;
            output.generation = { kind: output.mediaType, prompt: step.prompt, originalPrompt: step.originalPrompt,
                nodeType: step.kind, requestPrompt: step.prompt, promptDraftConfig, referenceBindings: bound.bindings,
                model: step.model, providerId: provider.id, sourceProviderId: provider.sourceProviderId,
                config: { ...promptDraftConfig }, references: [
                    ...bound.bindings.map(r => ({ itemId: r.sourceNodeId, filePath: r.filePath })),
                    ...outputReferences.filter(r => r.kind !== 'image').map(r => ({ itemId: r.nodeId, filePath: r.filePath }))
                ],
                generatedAt: Date.now(), taskId: result.taskId || step.remoteTaskId, agentRunId: run.id };
            for (const filePath of filePaths) appendGeneratorResult(output, { filePath, item: { filePath, mediaType: output.mediaType, generation: output.generation } });
        });
        // Later dependent steps consume the generated child, not a second request for the parent.
        this._wireNext(run, step, filePaths);
        return { nodeIds: [outputId], filePaths, sourceNodeId: step.nodeId, model: step.model };
    }
}
