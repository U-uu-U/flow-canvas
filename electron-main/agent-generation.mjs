import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { topoOrder, getPorts } from '../src/graph-model.js';
import { expandGenerationPrompts } from '../src/node-types.js';
import { getGeneratorResultEntries, appendGeneratorResult } from '../src/generator-result-stack.js';
import { resolveImageDimensions, resolveGenerationDisplaySize, inferClosestAspectRatio } from '../src/image-node-settings.js';
import { inferProviderCapability } from '../src/provider-capabilities.js';
import { getVideoModelProfile } from '../shared/video-model-profiles.mjs';
import adapters from './video-provider-adapters.js';
import { mediaKind } from './agent-media.cjs';

const copy = value => JSON.parse(JSON.stringify(value));
const error = (code, message) => Object.assign(new Error(message), { code });
const fingerprint = (node, connections) => crypto.createHash('sha256').update(JSON.stringify({
    id: node.id, kind: node.kind, nodeType: node.nodeType, config: node.config,
    filePath: node.filePath,
    primaryResult: getGeneratorResultEntries(node)[0]?.filePath || null,
    generation: node.kind === 'op' ? undefined : node.generation,
    inputs: connections.filter(c => c.to.nodeId === node.id && c.kind !== 'history')
})).digest('hex');

export class AgentGeneration {
    constructor({ board, bridge, loadConfig, fallbackDir }) { Object.assign(this, { board, bridge, loadConfig, fallbackDir }); }
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
    listModels() {
        return this.providers().filter(p => inferProviderCapability(p) !== 'text').map(p => {
            const kind = inferProviderCapability(p);
            const profile = kind === 'video' ? getVideoModelProfile(p) : null;
            const price = profile?.price?.kind === 'sale' ? profile.price : null;
            return { id: p.id, model: p.model, kind, name: p.name,
                ratios: profile?.ratios || ['adaptive', '1:1', '16:9', '9:16', '4:3', '3:4'],
                resolutions: profile?.resolutions || ['1K', '2K', '4K'], durations: profile?.durations,
                referenceLimits: profile?.referenceLimits, price,
                pricingStatus: price ? 'configured_sale' : 'unknown' };
        });
    }
    prepare(run, input) {
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
            const config = copy(node.config || {});
            if (node.id === run.source?.nodeId) Object.assign(config, run.source.parameters || {});
            // The orchestrator has already compiled the image intent into the node prompt.
            const count = Number(config.count ?? 1);
            if (!Number.isInteger(count) || count < 1 || count > 8) throw error('COUNT_LIMIT', '单节点每批次需要 1 到 8 次生成');
            const prompts = expandGenerationPrompts({ prompt: upstreamText }, { ...config, count });
            if (!prompts.length) throw error('PROMPT_REQUIRED', '生成节点缺少提示词');
            if (!Number.isInteger(count) || count < 1 || count > 8 || prompts.length > 8) throw error('COUNT_LIMIT', '单节点每批次最多 8 次生成');
            const provider = this.resolveProvider(config, node.nodeType);
            const profile = node.nodeType === 'video' ? getVideoModelProfile(provider) : null;
            if (profile && !profile.durations?.length) throw error('MODEL_CAPABILITY_UNKNOWN', '尚未收录该视频模型的参数能力，请先配置支持的模型');
            if (profile) {
                config.duration = Number(config.duration || profile.defaultDuration);
                config.resolution ||= profile.defaultResolution;
                config.ratio ||= profile.defaultRatio;
                if (!profile.durations.includes(config.duration)) throw error('INVALID_DURATION', '时长不在模型支持范围内');
                if (profile.resolutions.length && !profile.resolutions.includes(config.resolution)) throw error('INVALID_RESOLUTION', '分辨率不在模型支持范围内');
                if (!profile.ratios.includes(config.ratio)) throw error('INVALID_RATIO', '画幅比例不在模型支持范围内');
                for (const [field, supported] of [['webSearch', 'supportsWebSearch'], ['watermark', 'supportsWatermark'], ['cameraFixed', 'supportsCameraFixed'], ['generateAudio', 'supportsGeneratedAudio']]) {
                    if (config[field] && !profile[supported]) throw error('UNSUPPORTED_PARAMETER', `模型不支持 ${field}`);
                }
            }
            const references = inputs.filter(n => !texts.has(n.id)).map(n => ({ nodeId: n.id, filePath: steps.some(step => step.nodeId === n.id) ? '' : this._pathFor(n),
                kind: n.kind === 'op' ? n.nodeType : n.mediaType || mediaKind(n.filePath || ''), width: n.width, height: n.height }));
            const limits = profile?.referenceLimits;
            if (limits) for (const kind of ['image', 'video', 'audio']) {
                if (references.filter(r => r.kind === kind).length > (limits[kind] || 0)) throw error('REFERENCE_LIMIT', `该模型的 ${kind} 参考素材数量超限`);
            }
            for (const reference of references) if (reference.filePath) {
                if (!fs.existsSync(reference.filePath)) throw error('REFERENCE_MISSING', '参考素材已断联，请先修补');
                const stat = fs.statSync(reference.filePath);
                reference.fileFingerprint = `${stat.size}:${stat.mtimeMs}`;
            }
            const price = profile?.price?.kind === 'sale' ? copy(profile.price) : null;
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
        const config = step.config;
        const first = references.find(r => r.kind === 'image');
        const ratio = !config.ratio || config.ratio === 'adaptive' ? inferClosestAspectRatio(first?.width, first?.height,
            step.kind === 'video' ? getVideoModelProfile(provider).ratios.filter(r => r !== 'adaptive') : ['1:1', '16:9', '9:16', '4:3', '3:4'], '16:9') : config.ratio;
        const dimensions = resolveImageDimensions(config.resolutionTier || '2K', config.ratio || 'adaptive', first || {});
        const targetDir = path.join(project.defaultSaveFolder || this.fallbackDir, 'FlowCanvas-Agent', crypto.createHash('sha256').update(String(run.projectId)).digest('hex').slice(0, 12));
        const outputId = `result-${step.id}`;
        const existing = project.items.find(n => n.id === outputId);
        if (existing?.filePath && fs.existsSync(existing.filePath)) {
            const filePaths = getGeneratorResultEntries(existing).map(entry => entry.filePath).filter(Boolean);
            if (!filePaths.length) filePaths.push(existing.filePath);
            this._wireNext(run, step, filePaths);
            return { nodeIds: [existing.id], filePaths, sourceNodeId: step.nodeId, reused: true };
        }
        if (!existing) await this.board.updateProject(run.projectId, current => {
            this._validate(step, current);
            const display = resolveGenerationDisplaySize({ kind: step.kind, referenceSize: first, ratio, size: `${dimensions.width}x${dimensions.height}` });
            current.items.push({ id: outputId, kind: 'op', nodeType: step.kind, title: step.title,
                x: step.x + step.width + 64, y: step.y + run.steps.indexOf(step) * (step.height + 48),
                width: first?.width || display.width || step.width, height: first?.height || display.height || step.height,
                config: { ...config, prompt: step.prompt, count: 1, model: step.model }, runStatus: 'running',
                metadata: { agentRunId: run.id, agentStepId: step.id } });
            const parent = current.items.find(node => node.id === step.nodeId);
            current.connections.push({ id: `history-${step.id}`, kind: 'history',
                from: { nodeId: step.nodeId, port: getPorts(parent).outputs[0]?.name || step.kind }, to: { nodeId: outputId, port: 'source' } });
            references.forEach((reference, index) => {
                const generatedSource = run.results?.find(result => result.sourceNodeId === reference.nodeId && result.filePaths?.includes(reference.filePath));
                const sourceId = generatedSource?.nodeIds?.[0] || reference.nodeId;
                const source = current.items.find(node => node.id === sourceId);
                if (source) current.connections.push({ id: `reference-${step.id}-${index}`, kind: 'flow',
                    from: { nodeId: sourceId, port: getPorts(source).outputs[0]?.name || 'source' }, to: { nodeId: outputId, port: 'source' } });
            });
        });
        const body = { provider: step.kind === 'video' ? 'openai-video' : 'openai', providerConfig: provider,
            noSubmissionRetry: true, requestId: step.id,
            clientTaskId: step.id, prompt: step.prompt, targetDir, addToCanvas: false,
            sourceReferences: references.filter(r => r.kind === 'image').map(r => ({ filePath: r.filePath })),
            videoReferences: references.filter(r => r.kind === 'video').map(r => ({ filePath: r.filePath })),
            audioReferences: references.filter(r => r.kind === 'audio').map(r => ({ filePath: r.filePath })),
            size: config.size || `${dimensions.width}x${dimensions.height}`, quality: config.quality || 'high',
            responseFormat: config.responseFormat || 'url', ratio, resolution: config.resolution, duration: config.duration,
            generateAudio: !!config.generateAudio, cameraFixed: !!config.cameraFixed, watermark: !!config.watermark, webSearch: !!config.webSearch };
        if (step.kind === 'video' && adapters.isSeedance25Model(provider.model)) adapters.buildSeedance25RequestBody({ model: provider.model, prompt: step.prompt,
            duration: config.duration, resolution: config.resolution, aspectRatio: ratio, referenceImages: body.sourceReferences.map(r => r.filePath) });
        if (signal?.aborted) throw error('CANCELED', '已停止');
        const abort = () => this.bridge.cancelGenerationFromRenderer(step.id);
        signal?.addEventListener('abort', abort, { once: true });
        let result;
        try {
            if (step.filePaths?.length && step.filePaths.every(filePath => fs.existsSync(filePath))) {
                result = { filePaths: step.filePaths, taskId: step.remoteTaskId, mediaType: step.kind };
            } else if (resume) {
                if (!step.remoteTaskId) throw error('SUBMISSION_UNKNOWN', '缺少上游任务 ID，不会重复提交');
                result = await (step.kind === 'video' ? this.bridge.resumeVideoFromRenderer({ ...body, taskId: step.remoteTaskId })
                    : this.bridge.resumeImageFromRenderer({ ...body, taskId: step.remoteTaskId }));
            } else {
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
                model: step.model, providerId: provider.id, sourceProviderId: provider.sourceProviderId,
                config: { ...config, prompt: step.prompt }, references: references.map(r => ({ itemId: r.nodeId, filePath: r.filePath })),
                generatedAt: Date.now(), taskId: result.taskId || step.remoteTaskId, agentRunId: run.id };
            for (const filePath of filePaths) appendGeneratorResult(output, { filePath, item: { filePath, mediaType: output.mediaType, generation: output.generation } });
        });
        // Later dependent steps consume the generated child, not a second request for the parent.
        this._wireNext(run, step, filePaths);
        return { nodeIds: [outputId], filePaths, sourceNodeId: step.nodeId, model: step.model };
    }
}
