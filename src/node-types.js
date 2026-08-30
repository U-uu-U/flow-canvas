import {
    IMAGE_INTENT_PIPELINE,
    buildPlannerCacheKey,
    buildReferenceContext,
    compileImageProviderRequest,
    createGenerationTrace,
    createPlannerRequest,
    extractDeterministicSignals,
    validateEditPlan
} from './image-intent-pipeline.js';
import { isGptImage2Model, isMidjourneyImageModel } from './provider-capabilities.js';
import { inferClosestAspectRatio } from './image-node-settings.js';

// ============================================================
// Flow Canvas — Node Type Definitions (节点类型注册表)
// ============================================================
// 节点种类刻意少。三个对标产品的一致结论：Infinite-Canvas 5 个、
// Flora 3 个核心、Krea 模型多但节点抽象少。没有一家做数值/数学节点
// —— 那是 ComfyUI 调参工程师的需求，不是创作者的。
// 详见 docs/node-system-design.md。
//
// 每个节点类型定义：
// - type:    唯一标识
// - title:   显示名称
// - color:   标题栏颜色
// - icon:    图标键名，见 node-icons.js 的 NODE_ICON_NAMES
// - width:   节点默认宽度
// - inputs:  输入端口数组 [{ name, dataType, multi? }]
// - outputs: 输出端口数组 [{ name, dataType }]
// - config:  用户可编辑的参数 [{ key, label, type, default, options? }]
// - execute: async (inputs, config, ctx) => outputs
//
// ctx 由 graph-runner 注入：{ item, getTextProvider, getImageProvider, getVideoProvider,
// prepareImageReferences, createGenerationTask, updateGenerationTask, recordGenerationError }。
// ============================================================

const NODE_TYPES = {};
const imageIntentPlannerCache = new Map();
const IMAGE_INTENT_CACHE_TTL_MS = 30000;
const IMAGE_INTENT_CACHE_LIMIT = 50;

/** local-res:// URL → 文件路径。上游媒体端口传的都是这个协议。 */
function toFilePath(url) {
    const prefix = 'local-res://';
    if (typeof url !== 'string' || !url.startsWith(prefix)) return null;
    return decodeURIComponent(url.slice(prefix.length));
}

function toFileList(value) {
    return asArray(value)
        .map(toFilePath)
        .filter(Boolean)
        .map(filePath => ({ filePath }));
}

function localResourceType(value) {
    const filePath = toFilePath(value);
    if (!filePath) return null;
    const extension = filePath.split(/[?#]/, 1)[0].split('.').pop()?.toLowerCase() || '';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic', 'heif', 'tif', 'tiff'].includes(extension)) {
        return 'image';
    }
    if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'flv', 'mpeg', 'mpg'].includes(extension)) {
        return 'video';
    }
    return 'file';
}

function collectGenerationSources(inputs, legacyKeys = []) {
    return asArray([
        inputs?.source,
        ...legacyKeys.map(key => inputs?.[key])
    ]);
}

/** multi 端口给数组，普通端口给单值，统一成数组处理。 */
function asArray(value) {
    if (Array.isArray(value)) return value.flat().filter(v => v != null && v !== '');
    return value == null || value === '' ? [] : [value];
}

function referenceLabelNumber(label) {
    const value = String(label || '').trim();
    const chineseNumerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    const chineseIndex = chineseNumerals.findIndex(numeral => value === `图${numeral}`);
    if (chineseIndex >= 0) return chineseIndex + 1;
    const numeric = Number(value.match(/^图(\d+)$/)?.[1]);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function restoreReferenceCitations(prompt, config = {}) {
    const text = String(prompt || '');
    const ids = Array.isArray(config.referenceCitationIds) ? config.referenceCitationIds : [];
    const labels = Array.isArray(config.referenceCitationLabels) ? config.referenceCitationLabels : [];
    const offsets = config.referenceCitationOffsets && typeof config.referenceCitationOffsets === 'object'
        ? config.referenceCitationOffsets
        : {};
    const insertions = ids.map((id, index) => ({
        index,
        label: typeof labels[index] === 'string' ? labels[index].trim() : '',
        offset: Number(offsets[id])
    })).filter(entry => entry.label && Number.isFinite(entry.offset) && entry.offset >= 0 && entry.offset <= text.length);

    let restored = text;
    insertions
        .sort((left, right) => right.offset - left.offset || right.index - left.index)
        .forEach(entry => {
            restored = `${restored.slice(0, entry.offset)}${entry.label}${restored.slice(entry.offset)}`;
        });
    return restored;
}

function referenceCitationGuide(config = {}) {
    const labels = Array.isArray(config.referenceCitationLabels)
        ? config.referenceCitationLabels.filter(label => typeof label === 'string' && label.trim())
        : [];
    const mappings = labels.map(label => {
        const normalized = label.trim();
        const position = referenceLabelNumber(normalized);
        return position ? `${normalized}=第${position}张` : normalized;
    });
    return mappings.length ? `参考图编号与上传顺序一致：${mappings.join('，')}。` : '';
}

function withoutReferenceCitationGuide(prompt, config = {}) {
    const guide = referenceCitationGuide(config);
    const text = String(prompt || '');
    return guide && text.startsWith(`${guide}\n`) ? text.slice(guide.length + 1) : text;
}

function plannerProviderSummary(provider = {}) {
    provider = provider || {};
    return {
        id: provider.sourceProviderId || provider.id || null,
        name: provider.name || null,
        type: provider.type || 'openai',
        model: provider.model || null
    };
}

function imageProviderSummary(provider = {}) {
    provider = provider || {};
    return {
        id: provider.sourceProviderId || provider.id || null,
        name: provider.name || null,
        type: provider.type || 'openai',
        model: provider.model || null,
        endpoint: provider.endpoint || null
    };
}

function cachedPlannerRequest(cacheKey, requestFactory) {
    const now = Date.now();
    const cached = imageIntentPlannerCache.get(cacheKey);
    if (cached && now - cached.createdAt <= IMAGE_INTENT_CACHE_TTL_MS) {
        return { promise: cached.promise, cacheHit: true };
    }
    if (cached) imageIntentPlannerCache.delete(cacheKey);
    const promise = Promise.resolve().then(requestFactory);
    imageIntentPlannerCache.set(cacheKey, { promise, createdAt: now });
    while (imageIntentPlannerCache.size > IMAGE_INTENT_CACHE_LIMIT) {
        imageIntentPlannerCache.delete(imageIntentPlannerCache.keys().next().value);
    }
    return { promise, cacheHit: false };
}

function startImageIntentPipeline({ prompt, config, ctx, references, imageProvider }) {
    if (config?.skipImageIntentPipeline === true) return null;
    const requestedMode = ctx?.getImageIntentPipelineMode?.() || 'compiled';
    const mode = requestedMode === 'shadow' ? 'shadow' : requestedMode === 'off' ? 'off' : 'compiled';
    if (mode === 'off' || !references.length) return null;

    const promptWithReferenceTokens = withoutReferenceCitationGuide(prompt, config);
    const context = buildReferenceContext({
        targetNodeId: ctx?.item?.id,
        originalPrompt: promptWithReferenceTokens,
        promptWithReferenceTokens,
        sourceReferences: references,
        inputContext: ctx?.inputContext,
        config
    });
    const signals = extractDeterministicSignals(context);
    const plannerProvider = ctx?.getTextProvider?.() || null;
    const plannerApi = globalThis.window?.flowCanvas?.ai?.planImageEdit;
    const saveTrace = globalThis.window?.flowCanvas?.ai?.saveGenerationTrace;
    let plannerPromise;
    let cacheHit = false;

    if (!plannerProvider?.apiKey || !plannerProvider?.model) {
        plannerPromise = Promise.resolve({
            success: false,
            code: 'PLANNER_PROVIDER_UNAVAILABLE',
            error: '没有可用的文字与视觉 Provider'
        });
    } else if (typeof plannerApi !== 'function') {
        plannerPromise = Promise.resolve({
            success: false,
            code: 'PLANNER_API_UNAVAILABLE',
            error: '视觉意图规划接口不可用'
        });
    } else {
        const cacheKey = buildPlannerCacheKey(context, plannerProvider);
        const cached = cachedPlannerRequest(cacheKey, () => plannerApi({
            provider: plannerProvider,
            ...createPlannerRequest(context, signals)
        }));
        plannerPromise = cached.promise;
        cacheHit = cached.cacheHit;
    }

    const outcomePromise = plannerPromise
        .catch(error => ({
            success: false,
            code: 'PLANNER_NETWORK_ERROR',
            error: error?.message || String(error)
        }))
        .then(result => {
            const hashes = result?.referenceHashes || {};
            context.references.forEach(reference => {
                reference.originalImageHash = hashes[reference.referenceId] || null;
            });
            const validation = result?.success
                ? validateEditPlan(result.plan, context)
                : {
                    valid: false,
                    errors: [{ code: result?.code || 'PLANNER_FAILED', message: result?.error || 'Planner 请求失败' }],
                    warnings: []
                };
            const compiledRequest = validation.valid
                ? compileImageProviderRequest({
                    editPlan: validation.normalizedPlan,
                    context,
                    provider: imageProvider
                })
                : null;
            const fallback = !result?.success
                ? { used: true, reason: result?.code || 'PLANNER_FAILED' }
                : !validation.valid
                    ? { used: true, reason: 'PLANNER_SCHEMA_INVALID' }
                    : mode === 'compiled'
                        ? { used: false, reason: null }
                        : { used: true, reason: 'SHADOW_MODE' };
            return { result, validation, compiledRequest, fallback };
        });

    const persistTrace = async (generation, outcome) => {
        const { result, validation, compiledRequest, fallback } = outcome;
        const trace = createGenerationTrace({
            context,
            signals,
            planner: {
                enabled: true,
                mode,
                ...plannerProviderSummary(plannerProvider),
                plannerPromptVersion: IMAGE_INTENT_PIPELINE.plannerPromptVersion,
                cacheHit,
                durationMs: result?.durationMs,
                rawOutputAvailable: Boolean(result?.rawText)
            },
            validation,
            compiler: compiledRequest ? {
                providerId: compiledRequest.providerId,
                model: compiledRequest.model,
                compilerVersion: compiledRequest.compilerVersion,
                compiledPrompt: compiledRequest.prompt,
                compiledImageOrder: compiledRequest.images.map(image => image.referenceId),
                degradations: compiledRequest.degradations
            } : null,
            fallback,
            generation
        });
        if (typeof saveTrace === 'function') {
            const saved = await saveTrace(trace);
            if (saved?.success === false) console.warn('[ImageIntent] Trace 保存失败', saved.error);
        }
    };

    return {
        mode,
        resolve() {
            return outcomePromise;
        },
        finish(generation, resolvedOutcome = null) {
            void (resolvedOutcome ? Promise.resolve(resolvedOutcome) : outcomePromise)
                .then(outcome => persistTrace(generation, outcome))
                .catch(error => {
                    console.warn('[ImageIntent] Trace 保存失败', error);
                });
        }
    };
}

async function prepareGenerationReferences(references, prepare) {
    if (!references.length) return [];
    if (typeof prepare !== 'function') return references;
    const prepared = await prepare(references);
    if (!prepared) throw new Error('已取消参考图处理');
    if (Array.isArray(prepared)) return prepared;
    if (Array.isArray(prepared.references)) return prepared.references;
    throw new Error('参考图预处理未返回有效素材');
}

function expandGenerationPrompts(inputs, config = {}) {
    const agentCompiledPrompt = typeof config.agentCompiledPrompt === 'string'
        ? config.agentCompiledPrompt.trim()
        : '';
    if (agentCompiledPrompt) {
        const count = Math.max(1, Math.min(20, Number(config.count) || 1));
        const citationPrefix = referenceCitationGuide(config);
        const prompt = citationPrefix ? `${citationPrefix}\n${agentCompiledPrompt}` : agentCompiledPrompt;
        return Array.from({ length: count }, () => prompt);
    }
    const upstream = asArray(inputs?.prompt)
        .filter(value => typeof value === 'string' && value.trim());
    const configured = typeof config.prompt === 'string' && config.prompt.trim()
        ? restoreReferenceCitations(config.prompt, config)
        : '';
    const mergeMode = ['append', 'prepend', 'replace'].includes(config.promptMergeMode)
        ? config.promptMergeMode
        : 'append';
    let sources;
    if (!upstream.length) {
        sources = configured ? [configured] : [];
    } else if (!configured || mergeMode === 'replace') {
        sources = upstream;
    } else if (mergeMode === 'prepend') {
        sources = upstream.map(prompt => `${prompt}\n\n${configured}`);
    } else {
        sources = upstream.map(prompt => `${configured}\n\n${prompt}`);
    }
    const count = Math.max(1, Math.min(20, Number(config.count) || 1));
    const citationPrefix = referenceCitationGuide(config);
    return sources.flatMap(prompt => Array.from(
        { length: count },
        () => citationPrefix ? `${citationPrefix}\n${prompt}` : prompt
    ));
}

async function mapWithConcurrency(values, concurrency, worker) {
    const list = Array.isArray(values) ? values : [];
    if (!list.length) return [];
    const limit = Math.max(1, Math.min(list.length, Number(concurrency) || 1));
    const results = new Array(list.length);
    let cursor = 0;

    const consume = async () => {
        while (cursor < list.length) {
            const index = cursor++;
            results[index] = await worker(list[index], index);
        }
    };
    await Promise.all(Array.from({ length: limit }, consume));
    return results;
}

function packGenerationResults(portName, results) {
    if (results.length === 1) return results[0];
    return {
        [portName]: results.map(result => result[portName]).filter(Boolean),
        _batchResults: results
    };
}

// ── 文本 / Prompt ─────────────────────────────────────────
// 抄 Infinite-Canvas 的 smart-prompt：多模态（能吃上游的图和视频当上下文）、
// 可按分隔符拆成多个 prompt 项喂给批量节点。
// 同时吸收了原 text_merge 的职责 —— context 是 multi 端口，
// 多条上游文本按 separator 拼接，不需要单独的合并节点。
NODE_TYPES['text'] = {
    type: 'text',
    title: '文本 / Prompt',
    icon: 'pencil-line',
    color: '#6366f1',
    width: 320,
    inputs: [
        { name: 'context', dataType: 'any', multi: true }
    ],
    outputs: [
        { name: 'text', dataType: 'string' }
    ],
    config: [
        { key: 'useAi', label: '使用文字 AI 生成', type: 'checkbox', default: false },
        { key: 'text', label: '文本内容', type: 'textarea', default: '' },
        { key: 'separator', label: '上游拼接分隔符', type: 'text', default: '\n' },
        { key: 'splitBy', label: '拆分为多条（分隔符，留空不拆）', type: 'text', default: '' }
    ],
    async execute(inputs, config, ctx) {
        // 上游文本前置拼进本节点文本（消费者拉取，参考 node-system-design.md）
        const upstream = asArray(inputs.context)
            .filter(v => typeof v === 'string' && !v.startsWith('local-res://'));
        const sep = config.separator === '' ? '\n' : (config.separator ?? '\n');
        const own = config.text || '';
        const joined = [...upstream, own].filter(Boolean).join(sep);

        let outputText = joined;
        if (config.useAi) {
            if (!joined.trim()) throw new Error('请填写文字 AI 指令或连接上游文本');
            const provider = ctx?.getTextProvider?.(config);
            if (!provider?.apiKey) throw new Error('请先在设置中配置文字 AI 模型');
            if (!globalThis.window?.flowCanvas?.ai?.generateText) throw new Error('本地文字 AI 接口不可用');
            const result = await window.flowCanvas.ai.generateText({ provider, prompt: joined });
            if (!result?.success) throw new Error(result?.error || '文字 AI 请求失败');
            outputText = String(result.text || '').trim();
        }

        // splitBy 非空则拆成数组，下游批量/生成节点会逐条消费
        const splitBy = config.splitBy || '';
        if (splitBy) {
            const parts = outputText.split(splitBy).map(s => s.trim()).filter(Boolean);
            if (parts.length > 1) return { text: parts };
        }
        return { text: outputText };
    }
};

// ── 图像 ──────────────────────────────────────────────────
// 一个节点同时承担三个角色：素材容器 / 生成器 / 结果落地。
// 抄 Infinite-Canvas：没有独立的「输出节点」，生成结果自动新建节点承接
// （见 canvas.js 的 _spawnResultNode）。填了 prompt 就是生成器，
// 空 prompt 且有 filePath 就是纯素材，直接把自己的图透传给下游。
NODE_TYPES['image'] = {
    type: 'image',
    title: '图像',
    icon: 'image-plus',
    color: '#f59e0b',
    width: 520,
    spawnsResult: true,      // 执行后由 canvas 新建节点承接产物
    resultType: 'image',
    inputs: [
        { name: 'source', dataType: 'any', accepts: ['string', 'image'], multi: true }
    ],
    outputs: [
        { name: 'image', dataType: 'image' }
    ],
    config: [
        { key: 'prompt', label: '节点提示词', type: 'textarea', default: '' },
        { key: 'promptMergeMode', label: '上游提示词', type: 'select', default: 'append', options: ['append', 'prepend', 'replace'] },
        { key: 'negativePrompt', label: '反向提示词', type: 'textarea', default: '' },
        { key: 'resolutionTier', label: '画质', type: 'select', default: '4K', options: ['1K', '2K', '4K'] },
        { key: 'ratio', label: '画面比例', type: 'select', default: 'adaptive', options: ['adaptive', '1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9'] },
        { key: 'width', label: '宽度', type: 'number', default: 3840 },
        { key: 'height', label: '高度', type: 'number', default: 2160 },
        { key: 'quality', label: '生成质量', type: 'select', default: 'high', options: ['auto', 'low', 'medium', 'high'] },
        { key: 'responseFormat', label: '返回格式', type: 'select', default: 'url', options: ['url', 'b64_json'], gptImage2Only: true },
        { key: 'historyDisabled', label: '关闭历史记录', type: 'checkbox', default: true, gptImage2Only: true },
        { key: 'stream', label: '流式返回', type: 'checkbox', default: false, gptImage2Only: true },
        { key: 'style', label: '风格', type: 'select', default: '', options: ['', '写实', '产品摄影', '电影感', '插画', '极简'] },
        { key: 'cameraControl', label: '摄影机控制', type: 'select', default: '', options: ['', '自动', '特写', '近景', '中景', '广角', '俯拍'] },
        { key: 'webSearch', label: '联网搜索', type: 'checkbox', default: false },
        { key: 'count', label: '生成数量', type: 'number', default: 1 },
        { key: 'concurrency', label: '并发数', type: 'number', default: 3 }
    ],
    async execute(inputs, config, ctx) {
        const sources = collectGenerationSources(inputs, ['prompt', 'reference']);
        const provider = ctx?.getImageProvider?.(config);
        const midjourneyModel = isMidjourneyImageModel(provider?.model || config.model);
        const prompts = expandGenerationPrompts({
            prompt: sources.filter(value => typeof value === 'string' && !toFilePath(value))
        }, midjourneyModel ? { ...config, count: 1 } : config);

        // 纯素材模式：没有 prompt 但自身有文件，直接透传，不调 API
        const own = ctx?.item?.filePath;
        if (!prompts.length && own) {
            return { image: 'local-res://' + encodeURIComponent(own) };
        }
        if (!prompts.length) throw new Error('请填写提示词或连接上游文本');

        if (!provider?.apiKey) throw new Error('请先在 AI 助手设置中配置图像模型');
        if (!window.flowCanvas?.mcp?.generateImage) throw new Error('本地生图接口不可用');

        // 统一输入口按素材类型自动分流；自身素材仍作为首张参考图。
        const refs = toFileList(sources.filter(value => localResourceType(value) === 'image'));
        if (own && !refs.some(r => r.filePath === own)) refs.unshift({ filePath: own });
        const sourceReferences = await prepareGenerationReferences(refs, ctx?.prepareImageReferences);

        const resultGroups = await mapWithConcurrency(prompts, midjourneyModel ? 1 : config.concurrency, async prompt => {
            const effectivePrompt = [
                prompt,
                config.style ? `视觉风格：${config.style}` : '',
                config.cameraControl ? `摄影机控制：${config.cameraControl}` : ''
            ].filter(Boolean).join('\n');
            const intent = startImageIntentPipeline({
                prompt: effectivePrompt,
                config,
                ctx,
                references: refs,
                imageProvider: provider
            });
            const intentOutcome = intent?.mode === 'compiled' ? await intent.resolve() : null;
            const providerPrompt = intentOutcome?.fallback?.used === false && intentOutcome.compiledRequest?.prompt
                ? intentOutcome.compiledRequest.prompt
                : effectivePrompt;
            const requestPrompt = config.negativePrompt && !midjourneyModel
                ? `${providerPrompt}\n\nNegative: ${config.negativePrompt}`
                : providerPrompt;
            const imageModel = provider?.model || config.model;
            const gptImage2 = isGptImage2Model(imageModel);
            const imageRequestParams = {
                size: `${config.width || 1024}x${config.height || 1024}`,
                quality: config.quality || 'high',
                responseFormat: gptImage2 ? (config.responseFormat || 'url') : 'url',
                historyDisabled: gptImage2 ? config.historyDisabled !== false : true,
                stream: gptImage2 ? config.stream === true : false,
                nodeId: ctx?.item?.id || null
            };
            const generationTask = ctx?.createGenerationTask?.({
                kind: 'image',
                provider,
                prompt: requestPrompt,
                params: imageRequestParams,
                sourcePaths: sourceReferences.map(reference => reference.filePath).filter(Boolean)
            });
            const clientTaskId = typeof generationTask === 'string' ? generationTask : generationTask?.id;
            const generationStartedAt = Date.now();
            let result;
            try {
                result = await window.flowCanvas.mcp.generateImage({
                    provider: 'openai',
                    providerConfig: provider,
                    clientTaskId: clientTaskId || undefined,
                    prompt: requestPrompt,
                    size: imageRequestParams.size,
                    quality: imageRequestParams.quality,
                    webSearch: config.webSearch === true ? true : undefined,
                    responseFormat: imageRequestParams.responseFormat,
                    historyDisabled: imageRequestParams.historyDisabled,
                    stream: imageRequestParams.stream,
                    midjourney: midjourneyModel ? {
                        ratio: config.ratio,
                        version: config.midjourneyVersion,
                        raw: config.midjourneyRaw === true,
                        stylize: config.midjourneyStylize,
                        chaos: config.midjourneyChaos,
                        weird: config.midjourneyWeird,
                        quality: config.midjourneyQuality,
                        imageWeight: config.midjourneyImageWeight,
                        styleReference: config.midjourneyStyleReference,
                        styleWeight: config.midjourneyStyleWeight,
                        styleVersion: config.midjourneyStyleVersion,
                        omniReference: config.midjourneyOmniReference,
                        omniWeight: config.midjourneyOmniWeight,
                        profile: config.midjourneyProfile,
                        seed: config.midjourneySeed,
                        tile: config.midjourneyTile === true,
                        draft: config.midjourneyDraft === true,
                        repeat: config.midjourneyRepeat,
                        speed: config.midjourneySpeed,
                        visibility: config.midjourneyVisibility,
                        definition: config.resolutionTier === '2K' ? 'hd' : 'sd',
                        negativePrompt: config.negativePrompt
                    } : undefined,
                    sourceReferences,
                    addToCanvas: false
                });
            } catch (error) {
                if (clientTaskId) ctx?.recordGenerationError?.(clientTaskId, error);
                intent?.finish({
                    ...imageProviderSummary(provider),
                    status: 'failed',
                    durationMs: Date.now() - generationStartedAt,
                    requestPrompt,
                    imageOrder: sourceReferences.map(reference => reference.filePath),
                    error: error?.message || String(error)
                }, intentOutcome);
                throw error;
            }

            const filePaths = (Array.isArray(result?.filePaths) && result.filePaths.length
                ? result.filePaths
                : [result?.filePath || result?.item?.filePath]).filter(Boolean);
            const imageUrls = filePaths.length
                ? filePaths.map(filePath => 'local-res://' + encodeURIComponent(filePath))
                : [result?.url].filter(Boolean);
            if (!imageUrls.length) {
                if (clientTaskId) ctx?.recordGenerationError?.(clientTaskId, new Error(result?.error || '生图未返回图片'));
                intent?.finish({
                    ...imageProviderSummary(provider),
                    status: 'failed',
                    durationMs: Date.now() - generationStartedAt,
                    requestPrompt,
                    imageOrder: sourceReferences.map(reference => reference.filePath),
                    error: result?.error || '生图未返回图片'
                }, intentOutcome);
                throw new Error(result?.error || '生图未返回图片');
            }
            if (clientTaskId) {
                ctx?.updateGenerationTask?.(clientTaskId, {
                    status: 'success',
                    error: null,
                    filePath: filePaths[0] || null,
                    ...(result?.taskId ? { taskId: result.taskId } : {}),
                    params: { ...imageRequestParams, filePaths }
                });
            }
            intent?.finish({
                ...imageProviderSummary(provider),
                status: 'success',
                durationMs: Date.now() - generationStartedAt,
                requestPrompt,
                imageOrder: sourceReferences.map(reference => reference.filePath),
                filePath: filePaths[0] || null,
                filePaths,
                requestedSize: `${config.width || 1024}x${config.height || 1024}`,
                actualSize: result?.actualSize || null
            }, intentOutcome);
            return imageUrls.map((imageUrl, index) => ({
                image: imageUrl,
                _resultFilePath: filePaths[index] || null,
                _resultMediaType: result?.images?.[index]?.mediaType
                    || result?.mediaType
                    || localResourceType(imageUrl),
                _resultItem: index === 0 ? (result?.item || null) : null,
                _resultUrl: filePaths.length ? null : (result?.url || null),
                _midjourney: result?.midjourney || null,
                _candidateIndex: result?.images?.[index]?.candidateIndex || null,
                _preserveGeneratorStack: midjourneyModel && imageUrls.length > 1,
                _forceSquarePreview: midjourneyModel && imageUrls.length > 1
            }));
        });

        const results = resultGroups.flat();
        return packGenerationResults('image', results);
    }
};

// ── 视频 ──────────────────────────────────────────────────
// Flora 的典型链路：Text 写场景 → Image 出图 → 那张图喂给 Video 动起来。
// 复用 mcp-bridge 已有的 task_id 轮询（generateVideo 内部已实现跨重启恢复）。
NODE_TYPES['video'] = {
    type: 'video',
    title: '视频',
    icon: 'film',
    color: '#ec4899',
    width: 360,
    spawnsResult: true,
    resultType: 'video',
    inputs: [
        { name: 'source', dataType: 'any', accepts: ['string', 'image', 'video', 'file'], multi: true }
    ],
    outputs: [
        { name: 'video', dataType: 'video' }
    ],
    config: [
        { key: 'prompt', label: '提示词（留空则用上游）', type: 'textarea', default: '' },
        { key: 'ratio', label: '画面比例', type: 'select', default: '' },
        { key: 'resolution', label: '输出分辨率', type: 'select', default: '' },
        { key: 'duration', label: '时长（秒）', type: 'select', default: 5 },
        { key: 'cameraFixed', label: '固定镜头', type: 'checkbox', default: false },
        { key: 'generateAudio', label: '生成音频', type: 'checkbox', default: false },
        { key: 'webSearch', label: '联网搜索', type: 'checkbox', default: false },
        { key: 'watermark', label: '添加水印', type: 'checkbox', default: false },
        { key: 'count', label: '生成数量', type: 'number', default: 1 },
        { key: 'concurrency', label: '并发数', type: 'number', default: 2 }
    ],
    async execute(inputs, config, ctx) {
        const sources = collectGenerationSources(inputs, ['prompt', 'image', 'video', 'audio']);
        const prompts = expandGenerationPrompts({
            prompt: sources.filter(value => typeof value === 'string' && !toFilePath(value))
        }, {
            ...config,
            promptMergeMode: config.promptMergeMode || 'replace'
        });

        const own = ctx?.item?.filePath;
        if (!prompts.length && own) {
            return { video: 'local-res://' + encodeURIComponent(own) };
        }
        if (!prompts.length) throw new Error('请填写提示词或连接上游文本');

        const provider = ctx?.getVideoProvider?.(config);
        if (!provider?.apiKey) throw new Error('请先在 AI 助手设置中配置视频模型');
        if (!window.flowCanvas?.mcp?.generateVideo) throw new Error('本地视频接口不可用');

        // 统一输入口按扩展名分流为图片、视频和音频参考。
        const frames = toFileList(sources.filter(value => localResourceType(value) === 'image'));
        if (!frames.length && own) frames.push({ filePath: own });
        const firstFrameContext = (ctx?.inputContext || []).find(entry =>
            entry?.source?.filePath && entry.source.filePath === frames[0]?.filePath
        );
        const h3Model = /minimax[^a-z0-9]*h3/i.test(String(provider.model || config.model || ''));
        const useAdaptiveH3Ratio = h3Model
            && (config.ratio === 'adaptive' || config.ratioMode !== 'manual');
        const ratio = useAdaptiveH3Ratio
            ? inferClosestAspectRatio(
                firstFrameContext?.source?.width,
                firstFrameContext?.source?.height,
                ['16:9', '9:16', '1:1', '2:3', '3:2', '4:3', '3:4', '21:9'],
                '16:9'
            )
            : (config.ratio || undefined);
        const sourceReferences = await prepareGenerationReferences(frames, ctx?.prepareImageReferences);
        const videoReferences = toFileList(sources.filter(value => localResourceType(value) === 'video'));
        const audioReferences = toFileList(sources.filter(value => localResourceType(value) === 'file'));

        const results = await mapWithConcurrency(prompts, config.concurrency, async prompt => {
            const generationTask = ctx?.createGenerationTask?.({
                kind: 'video',
                provider,
                prompt,
                params: {
                    resolution: config.resolution || null,
                    ratio: ratio || null,
                    duration: Number(config.duration) || 5,
                    cameraFixed: Boolean(config.cameraFixed),
                    generateAudio: Boolean(config.generateAudio),
                    webSearch: Boolean(config.webSearch),
                    watermark: Boolean(config.watermark),
                    compressReferenceImages: false,
                    nodeId: ctx?.item?.id || null,
                    videoSourcePaths: videoReferences.map(reference => reference.filePath).filter(Boolean),
                    audioSourcePaths: audioReferences.map(reference => reference.filePath).filter(Boolean)
                },
                sourcePaths: sourceReferences.map(reference => reference.filePath).filter(Boolean)
            });
            const clientTaskId = typeof generationTask === 'string' ? generationTask : generationTask?.id;
            let result;
            try {
                result = await window.flowCanvas.mcp.generateVideo({
                    provider: 'openai-video',
                    providerConfig: provider,
                    clientTaskId: clientTaskId || undefined,
                    prompt,
                    resolution: config.resolution || undefined,
                    ratio,
                    duration: Number(config.duration) || 5,
                    cameraFixed: Boolean(config.cameraFixed),
                    generateAudio: Boolean(config.generateAudio),
                    webSearch: Boolean(config.webSearch),
                    watermark: Boolean(config.watermark),
                    sourceReferences,
                    videoReferences,
                    audioReferences,
                    addToCanvas: false
                });
                if (result?.success === false) throw new Error(result.error || '视频生成请求失败');
            } catch (error) {
                if (clientTaskId) ctx?.recordGenerationError?.(clientTaskId, error);
                throw error;
            }

            const filePath = result?.filePath || result?.item?.filePath || null;
            const videoUrl = filePath
                ? 'local-res://' + encodeURIComponent(filePath)
                : (result?.url || null);
            if (!videoUrl) {
                const error = new Error('视频生成未返回结果');
                if (clientTaskId) ctx?.recordGenerationError?.(clientTaskId, error);
                throw error;
            }
            if (clientTaskId) {
                ctx?.updateGenerationTask?.(clientTaskId, {
                    status: 'success',
                    error: null,
                    filePath,
                    ...(result?.taskId ? { taskId: result.taskId } : {}),
                    params: {
                        resolution: config.resolution || null,
                        ratio: ratio || null,
                        duration: Number(config.duration) || 5,
                        cameraFixed: Boolean(config.cameraFixed),
                        generateAudio: Boolean(config.generateAudio),
                        webSearch: Boolean(config.webSearch),
                        watermark: Boolean(config.watermark),
                        compressReferenceImages: false,
                        nodeId: ctx?.item?.id || null,
                        videoSourcePaths: videoReferences.map(reference => reference.filePath).filter(Boolean),
                        audioSourcePaths: audioReferences.map(reference => reference.filePath).filter(Boolean)
                    }
                });
            }
            return {
                video: videoUrl,
                _resultFilePath: filePath,
                _resultItem: result?.item || null,
                _resultUrl: result?.url || null
            };
        });

        return packGenerationResults('video', results);
    }
};

// ── 批量 ──────────────────────────────────────────────────
// 抄 Infinite-Canvas 的 smart-loop。这是节点图相对侧栏聊天最不可替代的
// 能力：一个 prompt 列表 × 多个变体一次跑完。
// 本节点只做「把 1 条 prompt 展开成 N 条」，实际并发由下游生成节点承担 ——
// 展开逻辑是纯函数，可单测；生成的重试/超时归生成节点自己管。
NODE_TYPES['batch'] = {
    type: 'batch',
    title: '批量',
    icon: 'layers',
    color: '#14b8a6',
    width: 300,
    inputs: [
        { name: 'prompt', dataType: 'string', multi: true }
    ],
    outputs: [
        { name: 'prompts', dataType: 'string' }
    ],
    config: [
        { key: 'count', label: '轮数', type: 'number', default: 4 },
        { key: 'startIndex', label: '起始序号', type: 'number', default: 1 },
        { key: 'template', label: '模板（留空用上游，《计数》为序号占位）', type: 'textarea', default: '' }
    ],
    async execute(inputs, config) {
        const count = Math.max(1, Math.min(200, Number(config.count) || 1));
        const start = Number.isFinite(Number(config.startIndex)) ? Number(config.startIndex) : 1;
        const base = asArray(inputs.prompt).filter(v => typeof v === 'string');
        const template = config.template || '';
        const sources = template ? [template] : (base.length ? base : ['']);

        // 每个上游 prompt × count 轮，序号连续递增。追加而非覆盖。
        const prompts = [];
        let index = start;
        for (const source of sources) {
            for (let i = 0; i < count; i++) {
                prompts.push(expandCounter(source, index));
                index += 1;
            }
        }
        return { prompts };
    }
};

/** 替换计数占位符。《计数》沿用 Infinite-Canvas 的写法，同时支持 {i}。 */
export function expandCounter(text, index) {
    return String(text ?? '')
        .replace(/《计数》/g, String(index))
        .replace(/\{i\}/g, String(index));
}

export {
    NODE_TYPES,
    toFilePath,
    toFileList,
    asArray,
    restoreReferenceCitations,
    prepareGenerationReferences,
    expandGenerationPrompts,
    mapWithConcurrency,
    startImageIntentPipeline
};
