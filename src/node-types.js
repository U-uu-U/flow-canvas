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
import { isMidjourneyImageModel } from './provider-capabilities.js';
import { imageGenerationRequestParams, normalizeVideoGenerationResolution } from './generation-request-params.js';
import { inferClosestAspectRatio } from './image-node-settings.js';
import { restoreReferenceCitations, referenceCitationGuide, withoutReferenceCitationGuide, bindReferenceCitations } from './reference-citations.js';

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

function throwIfGenerationCanceled(ctx, result = null) {
    if (ctx?.isCancelled?.() !== true && result?.canceled !== true) return;
    const error = new Error('生成任务已中断');
    error.name = 'AbortError';
    error.code = 'GENERATION_CANCELED';
    throw error;
}

/**
 * 把主进程返回的失败结果转成 Error，并保留其结构化语义。
 *
 * `submissionUnknown` 表示「服务端可能已受理、结果无法确认」，渲染层据此把任务
 * 归为 disconnected 而不是 failed，从而不引导用户直接重新提交（可能重复计费）。
 * 直接用 new Error(result.error) 会丢掉这个标记，只靠错误文案里的关键词去猜。
 */
function generationFailureError(result, fallbackMessage = '生图未返回图片') {
    const error = new Error(result?.error || fallbackMessage);
    if (result?.submissionUnknown === true) error.submissionUnknown = true;
    return error;
}

/** local-res:// URL → 文件路径。上游媒体端口传的都是这个协议。 */
function toFilePath(url) {
    const prefix = 'local-res://';
    if (typeof url !== 'string' || !url.startsWith(prefix)) return null;
    return decodeURIComponent(url.slice(prefix.length));
}

function toFileList(value) {
    return [...new Set(asArray(value)
        .map(toFilePath)
        .filter(Boolean))]
        .map(filePath => ({ filePath }));
}

/**
 * local-res:// URL → 媒体类型。
 *
 * 这份白名单必须覆盖画布侧认定为「图片」的全部扩展名
 * （见 canvas.js 的 _getFileType），否则会出现：合成器把某素材当作可引用的
 * 「图一」写进提示词，而这里把它判成 file 并在收集参考图时丢掉 —— 结果是
 * 请求带着「图一=第1张」的文字却一张图都没上传，静默退化为纯文生图。
 * `.ico` 曾经就是这种漏网扩展名之一。
 */
function localResourceType(value) {
    const filePath = toFilePath(value);
    if (!filePath) return null;
    const extension = filePath.split(/[?#]/, 1)[0].split('.').pop()?.toLowerCase() || '';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'heic', 'heif', 'tif', 'tiff'].includes(extension)) {
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
    ].flat(Infinity));
}

/** multi 端口给数组，普通端口给单值，统一成数组处理。 */
function asArray(value) {
    if (Array.isArray(value)) return value.flat().filter(v => v != null && v !== '');
    return value == null || value === '' ? [] : [value];
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

/**
 * 「用户主动放弃参考图」的显式标记。
 *
 * 素材准备有两种非数组结果，必须区分开：
 *   - CANCELED_IMAGE_REFERENCES：用户明确取消了参考图处理 → 中止生成并提示
 *   - 其它 falsy（null/undefined）：准备器不可用 → 属于异常，同样中止
 * 历史上两者都被折叠成空数组，导致「取消压缩对话框」变成
 * 「静默改用纯文生图」——模型收不到任何参考图，提示词里却仍写着「图一/图二」。
 *
 * 注意：这两条错误文案里**不能出现**「取消」「已取消」「cancel」等字样。
 * graph-runner 的 isCancellationError（graph-runner.js:34-38）会按文本匹配把它们
 * 误判成「用户中断了生成」，从而丢弃真正的失败原因、把节点标成 canceled。
 */
const CANCELED_IMAGE_REFERENCES = Object.freeze({ canceled: true });

async function prepareGenerationReferences(references, prepare) {
    if (!references.length) return [];
    if (typeof prepare !== 'function') return references;
    const prepared = await prepare(references);
    if (prepared === CANCELED_IMAGE_REFERENCES || prepared?.canceled === true) {
        throw new Error('参考图处理未完成，本次生成没有开始，也没有提交任何请求。请重新运行，并在参考图提示中选择“保持原图”或“批量转小”。');
    }
    if (!prepared) throw new Error('参考图准备服务不可用，本次生成没有开始，以避免丢失参考图。');
    const result = Array.isArray(prepared) ? prepared : prepared.references;
    if (!Array.isArray(result)) throw new Error('参考图预处理未返回有效素材');
    if (result.length !== references.length || result.some(reference => !reference?.filePath)) {
        throw new Error(`参考图处理不完整：选择了 ${references.length} 张，但只返回 ${result.filter(reference => reference?.filePath).length} 张有效素材，请重新添加素材`);
    }
    return result;
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
    const inputPrompts = asArray(inputs?.prompt).filter(value => typeof value === 'string' && value.trim());
    const upstream = inputPrompts.length ? inputPrompts : asArray(config.generationUpstreamPrompts);
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

function generationUserPrompt(prompt, config) {
    if (!config.agentCompiledPrompt) return withoutReferenceCitationGuide(prompt, config);
    return expandGenerationPrompts({}, { ...config, agentCompiledPrompt: '', count: 1 })
        .map(value => withoutReferenceCitationGuide(value, config)).join('\n\n');
}

/**
 * 有限并发地处理列表，保持结果顺序。
 *
 * 失败语义（重要）：任意一个 worker 抛错后，**其余 worker 不再领取新任务**，
 * 但已经在飞行中的请求会自然跑完；最后重新抛出第一个错误。
 *
 * 旧实现是裸 `Promise.all([...consume])`：首个 reject 立即向上抛，而其余 worker
 * 仍在 `while` 循环里继续领取剩余任务。后果是真实且要花钱的——
 *   - 图片：孤儿请求继续下载产物，并把各自的任务记录写成 success，而节点已被
 *     标成 ERROR → 磁盘堆孤儿文件、任务表与画布状态互相矛盾；
 *   - 视频：孤儿请求继续提交**付费**任务。
 * 因此这里必须显式止血，而不是让循环继续跑。
 */
async function mapWithConcurrency(values, concurrency, worker) {
    const list = Array.isArray(values) ? values : [];
    if (!list.length) return [];
    const limit = Math.max(1, Math.min(list.length, Number(concurrency) || 1));
    const results = new Array(list.length);
    let cursor = 0;
    let aborted = false;
    let firstError;

    const consume = async () => {
        while (!aborted && cursor < list.length) {
            const index = cursor++;
            try {
                results[index] = await worker(list[index], index);
            } catch (error) {
                // 只记住第一个错误并停止领取新任务；在飞的请求不打断
                // （打断需要各 worker 自己支持取消，属于调用方的职责）。
                if (!aborted) {
                    aborted = true;
                    firstError = error;
                }
                return;
            }
        }
    };
    await Promise.all(Array.from({ length: limit }, consume));
    if (aborted) {
        firstError.partialResults = results.filter(result => result !== undefined);
        firstError.unstartedIndices = list.slice(cursor).map((_, index) => cursor + index);
        throw firstError;
    }
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
        const own = ctx?.item?.filePath;
        const refs = toFileList(sources.filter(value => localResourceType(value) === 'image'));
        if (own && !refs.some(r => r.filePath === own)) refs.unshift({ filePath: own });
        const bound = bindReferenceCitations(config, refs, ctx?.inputContext);
        config = bound.config;
        const inputPrompts = sources.filter(value => typeof value === 'string' && !toFilePath(value));
        if (inputPrompts.length) config.generationUpstreamPrompts = inputPrompts;
        const promptDraftConfig = JSON.parse(JSON.stringify(config));
        const provider = ctx?.getImageProvider?.(config);
        const midjourneyModel = isMidjourneyImageModel(provider?.model || config.model);
        const prompts = expandGenerationPrompts({
            prompt: sources.filter(value => typeof value === 'string' && !toFilePath(value))
        }, midjourneyModel ? { ...config, count: 1 } : config);

        // 纯素材模式：没有 prompt 但自身有文件，直接透传，不调 API
        if (!prompts.length && own) {
            return { image: 'local-res://' + encodeURIComponent(own) };
        }
        if (!prompts.length) throw new Error('请填写提示词或连接上游文本');

        if (!provider?.apiKey) throw new Error('请先在 AI 助手设置中配置图像模型');
        if (!window.flowCanvas?.mcp?.generateImage) throw new Error('本地生图接口不可用');

        // 统一输入口按素材类型自动分流；自身素材仍作为首张参考图。
        const sourceReferences = await prepareGenerationReferences(refs, ctx?.prepareImageReferences);

        const resultGroups = await mapWithConcurrency(prompts, midjourneyModel ? 1 : config.concurrency, async prompt => {
            throwIfGenerationCanceled(ctx);
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
            throwIfGenerationCanceled(ctx);
            const providerPrompt = intentOutcome?.fallback?.used === false && intentOutcome.compiledRequest?.prompt
                ? intentOutcome.compiledRequest.prompt
                : effectivePrompt;
            const requestPrompt = config.negativePrompt && !midjourneyModel
                ? `${providerPrompt}\n\nNegative: ${config.negativePrompt}`
                : providerPrompt;
            const imageModel = provider?.model || config.model;
            const imageRequestParams = imageGenerationRequestParams(config, imageModel, ctx?.item?.id);
            ctx?.validateGenerationRequest?.({
                kind: 'image', provider, prompt: requestPrompt,
                fields: { resolutionTier: imageRequestParams.size, quality: imageRequestParams.quality, n: 1 },
                references: { image: { count: sourceReferences.length } }
            });
            const generationTask = ctx?.createGenerationTask?.({
                kind: 'image',
                provider,
                prompt: requestPrompt,
                promptDraftConfig,
                referenceBindings: bound.bindings,
                userPrompt: generationUserPrompt(prompt, config),
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
                    nodeId: ctx?.item?.id,
                    projectId: generationTask?.projectId,
                    targetDir: generationTask?.params?.targetDir || undefined,
                    prompt: requestPrompt,
                    promptDraftConfig,
                    referenceBindings: bound.bindings,
                    userPrompt: generationUserPrompt(prompt, config),
                    ...imageRequestParams,
                    sourceReferences,
                    addToCanvas: false
                });
                throwIfGenerationCanceled(ctx, result);
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
                const failure = generationFailureError(result);
                if (clientTaskId) ctx?.recordGenerationError?.(clientTaskId, failure);
                intent?.finish({
                    ...imageProviderSummary(provider),
                    status: 'failed',
                    durationMs: Date.now() - generationStartedAt,
                    requestPrompt,
                    imageOrder: sourceReferences.map(reference => reference.filePath),
                    error: failure.message
                }, intentOutcome);
                throw failure;
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
                _forceSquarePreview: midjourneyModel && imageUrls.length > 1,
                _generation: {
                    nodeType: 'image',
                    prompt: requestPrompt,
                    requestPrompt,
                    promptDraftConfig,
                    referenceBindings: bound.bindings,
                    model: imageModel || '',
                    providerId: provider?.id || null,
                    sourceProviderId: provider?.sourceProviderId || provider?.id || null,
                    config: {
                        ...config,
                        prompt: String(promptDraftConfig.prompt || ''),
                        model: imageModel || config.model || ''
                    },
                    references: sourceReferences.map(reference => ({
                        itemId: reference.itemId || null,
                        filePath: reference.filePath || ''
                    })),
                    taskId: result?.taskId || null,
                    generatedAt: Date.now()
                }
            }));
        }).catch(error => {
            if (error.partialResults?.length) error.partialOutput = packGenerationResults('image', error.partialResults.flat());
            throw error;
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
        const own = ctx?.item?.filePath;
        const frames = toFileList(sources.filter(value => localResourceType(value) === 'image'));
        if (!frames.length && own) frames.push({ filePath: own });
        const bound = bindReferenceCitations(config, frames, ctx?.inputContext);
        config = bound.config;
        const inputPrompts = sources.filter(value => typeof value === 'string' && !toFilePath(value));
        if (inputPrompts.length) config.generationUpstreamPrompts = inputPrompts;
        const promptDraftConfig = JSON.parse(JSON.stringify(config));
        const prompts = expandGenerationPrompts({
            prompt: sources.filter(value => typeof value === 'string' && !toFilePath(value))
        }, {
            ...config,
            promptMergeMode: config.promptMergeMode || 'replace'
        });

        if (!prompts.length && own) {
            return { video: 'local-res://' + encodeURIComponent(own) };
        }
        if (!prompts.length) throw new Error('请填写提示词或连接上游文本');

        const provider = ctx?.getVideoProvider?.(config);
        if (!provider?.apiKey) throw new Error('请先在 AI 助手设置中配置视频模型');
        if (!window.flowCanvas?.mcp?.generateVideo) throw new Error('本地视频接口不可用');

        // 统一输入口按扩展名分流为图片、视频和音频参考。
        const firstFrameContext = (ctx?.inputContext || []).find(entry =>
            entry?.source?.filePath && entry.source.filePath === frames[0]?.filePath
        );
        const videoModel = String(provider.model || config.model || '');
        config.resolution = normalizeVideoGenerationResolution(videoModel, config.resolution);
        const h3Model = /minimax[^a-z0-9]*h3/i.test(videoModel);
        const seedance25Model = /seedance[^a-z0-9]*(?:v[^a-z0-9]*)?2[._-]?5/i.test(videoModel)
            || /^sd2(?:\.5|_5|-5)(?:$|-haidiyue-face$)/i.test(videoModel.trim());
        const useAdaptiveReferenceRatio = (h3Model || seedance25Model)
            && (config.ratio === 'adaptive' || config.ratioMode !== 'manual');
        const supportedRatios = seedance25Model
            ? ['16:9', '9:16', '1:1', '4:3', '3:4']
            : ['16:9', '9:16', '1:1', '2:3', '3:2', '4:3', '3:4', '21:9'];
        const ratio = useAdaptiveReferenceRatio
            ? inferClosestAspectRatio(
                firstFrameContext?.source?.width,
                firstFrameContext?.source?.height,
                supportedRatios,
                '16:9'
            )
            : (config.ratio || undefined);
        const videoReferences = toFileList(sources.filter(value => localResourceType(value) === 'video'));
        const audioReferences = toFileList(sources.filter(value => localResourceType(value) === 'file'));

        for (const prompt of prompts) {
            ctx?.validateGenerationRequest?.({
                kind: 'video', provider, prompt,
                fields: { resolutionTier: config.resolution, ratio, duration: Number(config.duration) || 5 },
                features: {
                    cameraFixed: config.cameraFixed === true, generateAudio: config.generateAudio === true,
                    webSearch: config.webSearch === true, watermark: config.watermark === true
                },
                references: { image: { count: frames.length }, video: { count: videoReferences.length }, audio: { count: audioReferences.length } }
            });
        }

        const generationTasks = prompts.map(prompt => ctx?.createGenerationTask?.({
            kind: 'video',
            provider,
            prompt,
            promptDraftConfig,
            referenceBindings: bound.bindings,
            userPrompt: generationUserPrompt(prompt, config),
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
                syncStage: 'prepare',
                videoSourcePaths: videoReferences.map(reference => reference.filePath).filter(Boolean),
                audioSourcePaths: audioReferences.map(reference => reference.filePath).filter(Boolean)
            },
            sourcePaths: frames.map(reference => reference.filePath).filter(Boolean)
        }));

        let sourceReferences;
        try {
            sourceReferences = await prepareGenerationReferences(frames, ctx?.prepareImageReferences);
        } catch (error) {
            generationTasks.forEach(task => {
                const clientTaskId = typeof task === 'string' ? task : task?.id;
                if (clientTaskId) ctx?.recordGenerationError?.(clientTaskId, error);
            });
            throw error;
        }

        const results = await mapWithConcurrency(prompts, config.concurrency, async (prompt, index) => {
            throwIfGenerationCanceled(ctx);
            const generationTask = generationTasks[index];
            const clientTaskId = typeof generationTask === 'string' ? generationTask : generationTask?.id;
            if (clientTaskId) {
                ctx?.updateGenerationTask?.(clientTaskId, {
                    params: {
                        syncStage: 'submit'
                    },
                    sourcePaths: sourceReferences.map(reference => reference.filePath).filter(Boolean)
                });
            }
            let result;
            try {
                result = await window.flowCanvas.mcp.generateVideo({
                    provider: 'openai-video',
                    providerConfig: provider,
                    clientTaskId: clientTaskId || undefined,
                    nodeId: ctx?.item?.id,
                    projectId: generationTask?.projectId,
                    targetDir: generationTask?.params?.targetDir || undefined,
                    prompt,
                    promptDraftConfig,
                    referenceBindings: bound.bindings,
                    userPrompt: generationUserPrompt(prompt, config),
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
                throwIfGenerationCanceled(ctx, result);
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
                _resultUrl: result?.url || null,
                _generation: {
                    nodeType: 'video',
                    prompt,
                    requestPrompt: prompt,
                    promptDraftConfig,
                    referenceBindings: bound.bindings,
                    model: provider?.model || config.model || '',
                    providerId: provider?.id || null,
                    sourceProviderId: provider?.sourceProviderId || provider?.id || null,
                    config: {
                        ...config,
                        prompt: String(promptDraftConfig.prompt || ''),
                        ratio: ratio || config.ratio || '',
                        model: provider?.model || config.model || ''
                    },
                    references: sourceReferences.map(reference => ({
                        itemId: reference.itemId || null,
                        filePath: reference.filePath || ''
                    })),
                    taskId: result?.taskId || null,
                    generatedAt: Date.now()
                }
            };
        }).catch(error => {
            for (const index of error.unstartedIndices || []) {
                const task = generationTasks[index];
                const taskId = typeof task === 'string' ? task : task?.id;
                if (taskId) ctx?.updateGenerationTask?.(taskId, {
                    status: 'canceled', error: '批次中其他任务失败，本项尚未提交', params: { syncStage: 'not_submitted' }
                });
            }
            if (error.partialResults?.length) error.partialOutput = packGenerationResults('video', error.partialResults);
            throw error;
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
    startImageIntentPipeline,
    CANCELED_IMAGE_REFERENCES
};
