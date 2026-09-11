const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const { app, net } = require('electron');
const { PlanService, DEFAULT_MCP_CONFIG } = require('../shared/plan-service-core.cjs');
const {
    appendMidjourneyParameters,
    buildImageEditMultipart,
    buildMidjourneyCompatibilityPrompt,
    buildOpenAiImageRequestBody,
    buildImageTaskEndpoint,
    buildMidjourneyImaginePayload,
    buildMidjourneySubmitEndpoint,
    buildMidjourneyTaskEndpoint,
    collectImageEditInputs,
    describeGeneratedMedia,
    getGeneratedImageData,
    getGeneratedImageDataList,
    getImageTaskId,
    imageHttpErrorMessage,
    imageTaskErrorMessage,
    imageTaskRetryDelayMs,
    imageTaskStatus,
    isAllVendorsFailedImageResponse,
    isCompletedImageTaskStatus,
    isFailedImageTaskStatus,
    isImageTaskPayload,
    isMidjourneyImagineModel,
    isMidjourneyImageModel,
    isRetryableImageHttpStatus,
    isRetryableImageNetworkError,
    midjourneyGridRegions,
    parseImageApiResponseText,
    prependMidjourneyImagePrompts,
    shouldUseNativeMidjourneyRoute
} = require('./openai-image-request');
const { ReferenceCache } = require('./reference-cache');
const { GenerationRecoveryStore } = require('./generation-recovery-store.cjs');
const { imageRequestFailure } = require('./image-request-diagnostics.cjs');
const { diagnostic: recordDiagnostic } = require('./diagnostics.cjs');
const {
    buildMiniMaxH3RequestBody,
    buildSeedance25RequestBody,
    buildVideoGenerationEndpoint,
    getVideoPayloadError,
    getVideoResultUrl,
    getVideoTaskId,
    getVideoTaskProgress,
    getVideoTaskStatus,
    isMiniMaxH3Model,
    isMiniMaxH3NativeEndpoint,
    isMiniMaxH3PerSecondEndpoint,
    isMiniMaxH3UnavailableResponse,
    isSeedance25Model,
    resolveSeedance25AspectRatio,
    seedance25ReferenceImageLimit,
    videoModelFilePrefix
} = require('./video-provider-adapters');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v', '.wmv', '.flv', '.mpeg', '.mpg']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.aac', '.flac', '.ogg']);
const VIDEO_REFERENCE_UPLOAD_BUDGET_BYTES = 8 * 1024 * 1024;
const VIDEO_REFERENCE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TEMP_REFERENCE_CACHE_TTL_MS = 50 * 60 * 1000;
const TEMP_REFERENCE_UPLOAD_ATTEMPTS_PER_PROVIDER = 2;
const TEMP_REFERENCE_UPLOAD_CONCURRENCY = 2;
const GENERATED_MEDIA_DOWNLOAD_ATTEMPTS = 5;
const GENERATED_MEDIA_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024;
const GENERATED_MEDIA_DOWNLOAD_RETRY_DELAY_MS = 1_000;
const GENERATED_MEDIA_DOWNLOAD_HTTP1_TIMEOUT_MS = 90_000;
const GENERATED_MEDIA_DOWNLOAD_REDIRECT_LIMIT = 5;
const FALLBACK_TEMP_REFERENCE_UPLOAD_PROVIDERS = [
    {
        id: 'uguu',
        name: 'Uguu',
        endpoint: 'https://uguu.se/upload.php',
        fields: [],
        fileField: 'files[]',
        accept: 'application/json',
        responseType: 'json'
    },
    {
        id: 'litterbox',
        name: 'Litterbox',
        endpoint: 'https://litterbox.catbox.moe/resources/internals/api.php',
        fields: [
            ['reqtype', 'fileupload'],
            ['time', '1h']
        ],
        fileField: 'fileToUpload',
        accept: 'text/plain'
    }
];
const temporaryReferenceUrlCache = new Map();
const temporaryReferenceUploadTasks = new Map();
let referenceCache = null;
const DEFAULT_IMAGE_SIZE_OPTIONS = ['1024x1024', '1536x1024', '1024x1536'];
const RAVENHASH_IMAGE_SIZE_OPTIONS = [
    ...DEFAULT_IMAGE_SIZE_OPTIONS,
    '2048x2048',
    '2880x2880',
    '3840x2160',
    '2160x3840'
];
const BOARD_TOOL_REQUEST_TIMEOUT_MS = 20_000;

function generationCanceledError() {
    const error = new Error('生成任务已中断');
    error.name = 'AbortError';
    error.code = 'GENERATION_CANCELED';
    return error;
}

function throwIfGenerationCanceled(signal) {
    if (signal?.aborted) throw generationCanceledError();
}

function createLinkedAbortController(externalSignal, timeoutMs = 0) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener?.('abort', abort, { once: true });
    const timeout = timeoutMs > 0 ? setTimeout(abort, timeoutMs) : null;
    return {
        controller,
        cleanup() {
            if (timeout) clearTimeout(timeout);
            externalSignal?.removeEventListener?.('abort', abort);
        }
    };
}

function getReferenceCache() {
    if (!referenceCache) {
        referenceCache = new ReferenceCache(path.join(app.getPath('userData'), 'data', 'reference-cache'));
    }
    return referenceCache;
}
const ROUTE_TO_TOOL = {
    'GET /health': 'flow_canvas.health',
    'GET /config': 'flow_canvas.config.get',
    'PATCH /config': 'flow_canvas.config.update',
    'GET /context': 'flow_canvas.context.get_active_group',
    'GET /plans': 'flow_canvas.plan.list',
    'POST /plans': 'flow_canvas.plan.create',
    'GET /plans/:planId': 'flow_canvas.plan.get',
    'PATCH /plans/:planId': 'flow_canvas.plan.update',
    'DELETE /plans/:planId': 'flow_canvas.plan.delete',
    'POST /plans/:planId/rows': 'flow_canvas.plan.row.add',
    'PATCH /plans/:planId/rows/:rowId': 'flow_canvas.plan.row.update',
    'DELETE /plans/:planId/rows/:rowId': 'flow_canvas.plan.row.delete',
    'POST /plans/:planId/export': 'flow_canvas.plan.export',
    'GET /items': 'flow_canvas.item.list',
    'POST /items/add': 'flow_canvas.item.add',
    'GET /items/:itemId': 'flow_canvas.item.get',
    'PATCH /items/:itemId': 'flow_canvas.item.update',
    'DELETE /items/:itemId': 'flow_canvas.item.delete',
    'POST /board/snapshot': 'flow_canvas.board.get_snapshot',
    'POST /board/transactions/preview': 'flow_canvas.board.transaction.preview',
    'POST /board/transactions/apply': 'flow_canvas.board.transaction.apply',
    'POST /board/transactions/undo': 'flow_canvas.board.transaction.undo',
    'POST /images/generate': 'flow_canvas.image.generate',
    'POST /videos/generate': 'flow_canvas.video.generate'
};
const MANAGEMENT_TOOL_NAMES = [
    'flow_canvas.health',
    'flow_canvas.config.get',
    'flow_canvas.config.update'
];
const LEGACY_DEFAULT_TOOL_NAMES = [
    'flow_canvas.context.get_active_group',
    'flow_canvas.plan.list',
    'flow_canvas.plan.get',
    'flow_canvas.plan.create',
    'flow_canvas.plan.update',
    'flow_canvas.plan.row.add',
    'flow_canvas.plan.row.update',
    'flow_canvas.plan.row.delete',
    'flow_canvas.plan.delete',
    'flow_canvas.plan.export',
    'flow_canvas.image.generate',
    'flow_canvas.item.add'
];
const KNOWN_TOOL_NAMES = new Set([
    ...Object.values(ROUTE_TO_TOOL),
    ...DEFAULT_MCP_CONFIG.allowedTools
]);

class FlowCanvasBridge {
    constructor({ store, getMainWindow, getDefaultSaveFolder, getFallbackSaveDir, notifyRenderer, notifyTaskSubmitted, notifyTaskCompleted, notifyVideoProgress, boardToolRequestTimeoutMs, recoveryDirectory }) {
        this.store = store;
        this.getMainWindow = getMainWindow;
        this.getDefaultSaveFolder = getDefaultSaveFolder;
        this.getFallbackSaveDir = getFallbackSaveDir;
        this.notifyRenderer = notifyRenderer;
        this.notifyTaskSubmitted = notifyTaskSubmitted;
        this.notifyTaskCompleted = notifyTaskCompleted;
        const progressStates = new Map();
        this.notifyVideoProgress = event => {
            const key = event.clientTaskId || 'unknown';
            const signature = `${event.stage}:${Math.floor((Number(event.progress) || 0) / 10)}:${event.retryCount || 0}`;
            if (progressStates.get(key) !== signature) {
                if (progressStates.size >= 500) progressStates.delete(progressStates.keys().next().value);
                progressStates.set(key, signature);
                recordDiagnostic('info', 'generation.progress', { clientTaskId: event.clientTaskId, stage: event.stage,
                    progress: event.progress, retryCount: event.retryCount, lastError: event.lastError });
            }
            notifyVideoProgress?.(event);
        };
        this.server = null;
        this.host = DEFAULT_MCP_CONFIG.host;
        this.port = DEFAULT_MCP_CONFIG.port;
        this.allowedTools = new Set(DEFAULT_MCP_CONFIG.allowedTools);
        this.boardMutationQueue = Promise.resolve();
        this.boardToolsReady = false;
        this.pendingBoardToolRequests = new Map();
        this.activeGenerationRequests = new Map();
        this.canceledGenerationRequests = new Map();
        this.recoveryStore = new GenerationRecoveryStore(recoveryDirectory);
        this.recoveryRequests = new Map();
        this.boardToolRequestTimeoutMs = sanitizeBoardToolTimeout(boardToolRequestTimeoutMs);
    }

    async _runCancelableGeneration(clientTaskId, action) {
        const id = String(clientTaskId || '').trim();
        const controller = new AbortController();
        const canceledUntil = id ? Number(this.canceledGenerationRequests.get(id)) || 0 : 0;
        if (canceledUntil > Date.now()) controller.abort();
        if (id) {
            this.activeGenerationRequests.get(id)?.abort();
            this.activeGenerationRequests.set(id, controller);
        }
        try {
            throwIfGenerationCanceled(controller.signal);
            recordDiagnostic('info', 'generation.start', { clientTaskId: id });
            const result = await action(controller.signal);
            throwIfGenerationCanceled(controller.signal);
            recordDiagnostic('info', 'generation.complete', { clientTaskId: id, taskId: result?.taskId });
            return result;
        } catch (error) {
            recordDiagnostic('error', 'generation.failed', { clientTaskId: id, canceled: controller.signal.aborted, error });
            throw error;
        } finally {
            if (id && this.activeGenerationRequests.get(id) === controller) {
                this.activeGenerationRequests.delete(id);
            }
            if (id && (Number(this.canceledGenerationRequests.get(id)) || 0) <= Date.now()) {
                this.canceledGenerationRequests.delete(id);
            }
        }
    }

    cancelGenerationFromRenderer(clientTaskId) {
        const id = String(clientTaskId || '').trim();
        if (!id) return { canceled: false, error: '缺少任务 ID' };
        this.canceledGenerationRequests.set(id, Date.now() + 60_000);
        const controller = this.activeGenerationRequests.get(id);
        controller?.abort();
        this.activeGenerationRequests.get(`recover:${id}`)?.abort();
        return { canceled: true, active: Boolean(controller) };
    }

    _rememberGeneration(kind, body) {
        const request = { ...body, clientTaskId: body.clientTaskId || crypto.randomUUID(),
            projectId: body.projectId || this.store.load().activeGroupId || null };
        recordDiagnostic('info', 'generation.prepare', { kind, clientTaskId: request.clientTaskId,
            projectId: request.projectId, nodeId: body.nodeId, model: body.providerConfig?.model || body.model,
            endpoint: body.providerConfig?.endpoint, imageCount: body.sourceReferences?.length || 0,
            videoCount: body.videoReferences?.length || 0, audioCount: body.audioReferences?.length || 0,
            size: body.size, duration: body.duration, resolution: body.resolution, stream: body.stream });
        const params = Object.fromEntries(['size', 'quality', 'responseFormat', 'historyDisabled', 'stream',
            'ratio', 'resolution', 'duration', 'cameraFixed', 'generateAudio', 'webSearch', 'watermark', 'n', 'midjourney']
            .filter(key => body[key] !== undefined).map(key => [key, body[key]]));
        params.videoSourcePaths = (body.videoReferences || []).map(reference => reference.filePath).filter(Boolean);
        params.audioSourcePaths = (body.audioReferences || []).map(reference => reference.filePath).filter(Boolean);
        this.recoveryStore.update(request.clientTaskId, {
            kind, projectId: request.projectId, nodeId: body.nodeId || null,
            providerId: body.providerConfig?.sourceProviderId || body.providerConfig?.id || null,
            endpoint: body.providerConfig?.endpoint || '', model: body.providerConfig?.model || body.model || '',
            prompt: body.prompt || '', taskId: null, result: null, location: null,
            params, sourcePaths: (body.sourceReferences || []).map(reference => reference.filePath).filter(Boolean),
            targetDir: body.targetDir || null, state: 'submitting', createdAt: new Date().toISOString()
        });
        return request;
    }

    _rememberSubmitted(body, event) {
        recordDiagnostic('info', 'generation.submitted', { clientTaskId: body.clientTaskId, projectId: body.projectId,
            nodeId: body.nodeId, taskId: event.remoteTaskId, model: event.model, location: event.location });
        this.recoveryStore.update(body.clientTaskId, { taskId: event.remoteTaskId,
            targetDir: event.targetDir, model: event.model, state: 'submitted',
            ...(event.location ? { location: event.location } : {}) });
        this.notifyTaskSubmitted?.({ ...event, projectId: body.projectId });
    }

    _rememberResult(body, result) {
        recordDiagnostic('info', 'generation.downloaded', { clientTaskId: body.clientTaskId, projectId: body.projectId,
            taskId: result.taskId, count: result.filePaths?.length || (result.filePath ? 1 : 0) });
        if (!this.recoveryStore.get(body.clientTaskId)?.kind) {
            this.recoveryStore.update(body.clientTaskId, { kind: result.mediaType || body.kind,
                projectId: body.projectId, nodeId: body.nodeId, prompt: body.prompt,
                endpoint: body.providerConfig?.endpoint, model: body.providerConfig?.model,
                providerId: body.providerConfig?.sourceProviderId || body.providerConfig?.id });
        }
        this.recoveryStore.update(body.clientTaskId, { result, state: 'downloaded',
            ...(result.targetDir ? { targetDir: result.targetDir } : {}),
            ...(result.taskId ? { taskId: result.taskId } : {}) });
    }

    async recoverGenerationFromRenderer(body = {}) {
        let existing = this.recoveryStore.find({ clientTaskId: body.clientTaskId, taskId: body.taskId,
            kind: body.kind, endpoint: body.providerConfig?.endpoint });
        const original = this.recoveryStore.get(body.clientTaskId);
        if (!existing && original) existing = { ...original, taskId: body.taskId, result: null, location: null };
        const kind = existing?.kind || body.kind;
        if (!['image', 'video'].includes(kind)) throw new Error('请选择图片或视频任务');
        const taskId = String(body.taskId || existing?.taskId || '').trim();
        const clientTaskId = existing?.clientTaskId || body.clientTaskId || crypto.randomUUID();
        const key = clientTaskId;
        if (this.recoveryRequests.has(key)) return this.recoveryRequests.get(key);
        this.activeGenerationRequests.get(clientTaskId)?.abort();
        const config = { ...body.providerConfig };
        // Route and model are frozen; only the current credential is supplied by the caller.
        if (existing?.endpoint) config.endpoint = existing.endpoint;
        if (existing?.model) config.model = existing.model;
        const request = { ...body, kind, taskId, clientTaskId, providerConfig: config,
            projectId: existing?.projectId || body.projectId,
            nodeId: existing?.nodeId || body.nodeId, prompt: existing?.prompt || body.prompt || '',
            params: existing?.params || body.params, sourcePaths: existing?.sourcePaths || body.sourcePaths,
            targetDir: existing?.targetDir || body.targetDir, location: existing?.location, addToCanvas: false };
        request.targetSignature = this.captureRecoveryTarget?.(request);
        const work = this._runCancelableGeneration(`recover:${clientTaskId}`, async signal => {
            let result = existing?.result;
            const paths = result?.filePaths?.length ? result.filePaths : [result?.filePath].filter(Boolean);
            if (!paths.length || !paths.every(filePath => fs.existsSync(filePath))) {
                if (!taskId) throw new Error('没有上游任务 ID，请从服务商后台复制任务 ID 后拉取；不会重新提交生成');
                if (!config.apiKey || !config.endpoint) throw new Error('请先恢复原任务使用的 API 配置');
                if (existing?.providerId && body.providerConfig?.id
                    && String(existing.providerId).split('::model:')[0] !== String(body.providerConfig.sourceProviderId || body.providerConfig.id).split('::model:')[0]) {
                    throw new Error('恢复必须使用原任务的 API 账号');
                }
                this.recoveryStore.update(clientTaskId, { kind, taskId, projectId: request.projectId,
                    nodeId: request.nodeId, endpoint: config.endpoint, model: config.model, prompt: request.prompt,
                    providerId: existing?.providerId || config.sourceProviderId || config.id,
                    result: null, location: request.location || null, state: 'recovering' });
                result = await (kind === 'video' ? this._resumeVideoFromRenderer(request, signal)
                    : this._resumeImageFromRenderer(request, signal));
                this._rememberResult(request, result);
            }
            throwIfGenerationCanceled(signal);
            if (typeof this.attachRecoveredGeneration !== 'function') throw new Error('画板恢复服务尚未就绪，产物已保留');
            const attached = await this.attachRecoveredGeneration(request, result, signal);
            this.recoveryStore.update(clientTaskId, { state: 'attached', nodeId: attached.nodeId });
            this.notifyTaskCompleted?.({ clientTaskId, remoteTaskId: result.taskId || taskId,
                projectId: request.projectId, filePath: result.filePath, filePaths: result.filePaths,
                recovered: true, nodeId: attached.nodeId });
            return { ...result, ...attached, taskId: result.taskId || taskId, recovered: true };
        });
        this.recoveryRequests.set(key, work);
        try { return await work; }
        finally { if (this.recoveryRequests.get(key) === work) this.recoveryRequests.delete(key); }
    }

    _commitBoardMutation(action) {
        const commit = this.boardMutationQueue.catch(() => {}).then(action);
        this.boardMutationQueue = commit;
        return commit;
    }

    start(config = {}) {
        const merged = {
            ...DEFAULT_MCP_CONFIG,
            ...config
        };
        if (!merged.enabled) return false;

        this.host = sanitizeHost(merged.host);
        this.port = sanitizePort(merged.port);
        this.allowedTools = new Set(sanitizeAllowedTools(merged.allowedTools));
        if (this.server) return true;

        this.server = http.createServer((req, res) => {
            this._handleRequest(req, res).catch(error => {
                const serialized = serializeBridgeError(error);
                this._sendJson(res, serialized.status, {
                    success: false,
                    error: serialized.message,
                    code: serialized.code,
                    details: serialized.details
                });
            });
        });

        this.server.on('error', error => {
            console.error('[FlowCanvasBridge] failed:', error.message);
        });

        this.server.listen(this.port, this.host, () => {
            console.log(`[FlowCanvasBridge] listening on http://${this.host}:${this.port}`);
        });
        return true;
    }

    stop() {
        this.setBoardToolsReady(false, {
            code: 'BRIDGE_STOPPED',
            message: 'Flow Canvas bridge stopped'
        });
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }

    setBoardToolsReady(ready, reason = {}) {
        this.boardToolsReady = ready === true;
        if (this.boardToolsReady) return;
        this._rejectPendingBoardToolRequests(createBridgeError(
            reason.code || 'RENDERER_NOT_READY',
            reason.message || 'Flow Canvas board renderer is not ready',
            reason.details,
            reason.status || 503
        ));
    }

    handleBoardToolResponse(payload = {}) {
        const requestId = String(payload.requestId || '').trim();
        const pending = this.pendingBoardToolRequests.get(requestId);
        if (!pending) return false;
        this.pendingBoardToolRequests.delete(requestId);
        clearTimeout(pending.timer);

        if (payload.success === true) {
            pending.resolve(payload.result);
            return true;
        }

        const error = payload.error && typeof payload.error === 'object' ? payload.error : {};
        pending.reject(createBridgeError(
            error.code || 'BOARD_TOOL_FAILED',
            error.message || `Flow Canvas board tool failed: ${pending.toolName}`,
            error.details,
            error.status
        ));
        return true;
    }

    _requestBoardTool(toolName, input = {}) {
        if (this.agentBoardExecutor) return Promise.resolve(this.agentBoardExecutor(toolName, input));
        if (!this.boardToolsReady) {
            return Promise.reject(createBridgeError(
                'RENDERER_NOT_READY',
                'Flow Canvas board renderer is not ready; open the canvas and wait for it to finish loading',
                null,
                503
            ));
        }

        const window = this.getMainWindow?.();
        if (!window || window.isDestroyed?.() || !window.webContents || window.webContents.isDestroyed?.()) {
            return Promise.reject(createBridgeError(
                'RENDERER_NOT_READY',
                'Flow Canvas main window is unavailable',
                null,
                503
            ));
        }

        const requestId = crypto.randomUUID?.() || makeId('board_request');
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingBoardToolRequests.delete(requestId);
                reject(createBridgeError(
                    'BOARD_TOOL_TIMEOUT',
                    `Flow Canvas board tool timed out: ${toolName}`,
                    { toolName, timeoutMs: this.boardToolRequestTimeoutMs },
                    504
                ));
            }, this.boardToolRequestTimeoutMs);
            timer.unref?.();
            this.pendingBoardToolRequests.set(requestId, { resolve, reject, timer, toolName });

            try {
                window.webContents.send('mcp:board-tool-request', {
                    requestId,
                    toolName,
                    input: clone(input || {})
                });
            } catch (error) {
                this.pendingBoardToolRequests.delete(requestId);
                clearTimeout(timer);
                reject(createBridgeError(
                    'RENDERER_UNAVAILABLE',
                    `Failed to send board tool request: ${error.message}`,
                    { toolName },
                    503
                ));
            }
        });
    }

    _rejectPendingBoardToolRequests(error) {
        for (const pending of this.pendingBoardToolRequests.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pendingBoardToolRequests.clear();
    }

    async _handleRequest(req, res) {
        if (!isLocalAddress(req.socket.remoteAddress)) {
            this._sendJson(res, 403, { success: false, error: 'Only localhost clients are allowed' });
            return;
        }

        if (req.method === 'OPTIONS') {
            this._sendJson(res, 204, null);
            return;
        }

        const url = new URL(req.url, `http://${this.host}:${this.port}`);
        const body = await readJsonBody(req);
        const route = this._matchRoute(req.method, url.pathname);
        if (!route) {
            this._sendJson(res, 404, { success: false, error: 'Unknown Flow Canvas API route' });
            return;
        }
        if (!this._isToolAllowed(route.toolName)) {
            this._sendJson(res, 403, { success: false, error: `MCP tool is not allowed: ${route.toolName}` });
            return;
        }

        const result = await route.handler(route.params, body || {}, url);
        this._sendJson(res, 200, { success: true, ...result });
    }

    _matchRoute(method, pathname) {
        if (method === 'POST' && pathname.startsWith('/agent/tools/')) {
            const toolName = decodeURIComponent(pathname.slice('/agent/tools/'.length));
            if (!KNOWN_TOOL_NAMES.has(toolName)) return null;
            return { toolName, params: {}, handler: async (_, body) => {
                if (!this.agentExecutor) throw new Error('Agent runtime unavailable');
                return { result: await this.agentExecutor(toolName, body) };
            } };
        }
        const routes = [
            ['GET', /^\/health$/, ROUTE_TO_TOOL['GET /health'], () => this._health()],
            ['GET', /^\/config$/, ROUTE_TO_TOOL['GET /config'], () => this._getConfig()],
            ['PATCH', /^\/config$/, ROUTE_TO_TOOL['PATCH /config'], (_, body) => this._updateConfig(body)],
            ['GET', /^\/context$/, ROUTE_TO_TOOL['GET /context'], () => this._context()],
            ['GET', /^\/plans$/, ROUTE_TO_TOOL['GET /plans'], () => this._listPlans()],
            ['POST', /^\/plans$/, ROUTE_TO_TOOL['POST /plans'], (_, body) => this._createPlan(body)],
            ['GET', /^\/plans\/([^/]+)$/, ROUTE_TO_TOOL['GET /plans/:planId'], ({ planId }) => this._getPlan(planId)],
            ['PATCH', /^\/plans\/([^/]+)$/, ROUTE_TO_TOOL['PATCH /plans/:planId'], ({ planId }, body) => this._updatePlan(planId, body)],
            ['DELETE', /^\/plans\/([^/]+)$/, ROUTE_TO_TOOL['DELETE /plans/:planId'], ({ planId }) => this._deletePlan(planId)],
            ['POST', /^\/plans\/([^/]+)\/rows$/, ROUTE_TO_TOOL['POST /plans/:planId/rows'], ({ planId }, body) => this._addRow(planId, body)],
            ['PATCH', /^\/plans\/([^/]+)\/rows\/([^/]+)$/, ROUTE_TO_TOOL['PATCH /plans/:planId/rows/:rowId'], ({ planId, rowId }, body) => this._updateRow(planId, rowId, body)],
            ['DELETE', /^\/plans\/([^/]+)\/rows\/([^/]+)$/, ROUTE_TO_TOOL['DELETE /plans/:planId/rows/:rowId'], ({ planId, rowId }) => this._deleteRow(planId, rowId)],
            ['POST', /^\/plans\/([^/]+)\/export$/, ROUTE_TO_TOOL['POST /plans/:planId/export'], ({ planId }) => this._exportPlan(planId)],
            ['GET', /^\/items$/, ROUTE_TO_TOOL['GET /items'], () => this._listItems()],
            ['POST', /^\/items\/add$/, ROUTE_TO_TOOL['POST /items/add'], (_, body) => this._addItem(body)],
            ['GET', /^\/items\/([^/]+)$/, ROUTE_TO_TOOL['GET /items/:itemId'], ({ itemId }) => this._getItem(itemId)],
            ['PATCH', /^\/items\/([^/]+)$/, ROUTE_TO_TOOL['PATCH /items/:itemId'], ({ itemId }, body) => this._updateItem(itemId, body)],
            ['DELETE', /^\/items\/([^/]+)$/, ROUTE_TO_TOOL['DELETE /items/:itemId'], ({ itemId }) => this._deleteItem(itemId)],
            ['POST', /^\/board\/snapshot$/, ROUTE_TO_TOOL['POST /board/snapshot'], (_, body) => this._requestBoardTool(ROUTE_TO_TOOL['POST /board/snapshot'], body)],
            ['POST', /^\/board\/transactions\/preview$/, ROUTE_TO_TOOL['POST /board/transactions/preview'], (_, body) => this._requestBoardTool(ROUTE_TO_TOOL['POST /board/transactions/preview'], body)],
            ['POST', /^\/board\/transactions\/apply$/, ROUTE_TO_TOOL['POST /board/transactions/apply'], (_, body) => this._commitBoardMutation(() => this._requestBoardTool(ROUTE_TO_TOOL['POST /board/transactions/apply'], body))],
            ['POST', /^\/board\/transactions\/undo$/, ROUTE_TO_TOOL['POST /board/transactions/undo'], (_, body) => this._commitBoardMutation(() => this._requestBoardTool(ROUTE_TO_TOOL['POST /board/transactions/undo'], body))],
            ['POST', /^\/images\/generate$/, ROUTE_TO_TOOL['POST /images/generate'], (_, body) => this._generateImage(body)],
            ['POST', /^\/videos\/generate$/, ROUTE_TO_TOOL['POST /videos/generate'], (_, body) => this._generateVideo(body)]
        ];

        for (const [routeMethod, pattern, toolName, handler] of routes) {
            if (routeMethod !== method) continue;
            const match = pathname.match(pattern);
            if (!match) continue;
            return {
                params: {
                    planId: match[1] ? decodeURIComponent(match[1]) : undefined,
                    rowId: match[2] ? decodeURIComponent(match[2]) : undefined,
                    itemId: match[1] ? decodeURIComponent(match[1]) : undefined
                },
                toolName,
                handler
            };
        }
        return null;
    }

    _isToolAllowed(toolName) {
        if (!toolName) return false;
        return this.allowedTools.has(toolName);
    }

    _loadWithPlanService() {
        const data = this.store.load();
        const planService = new PlanService(data);
        return { data, planService };
    }

    _saveAndNotify(data, event = 'mcp:update', options = {}) {
        if (options.bumpRevision !== false) bumpBoardRevision(data);
        const ok = this.store.save(data);
        if (!ok) throw new Error('Failed to save Flow Canvas board data');
        this.notifyRenderer?.(event, data);
    }

    _health() {
        const { data } = this._loadWithPlanService();
        return {
            bridge: 'flow-canvas.local-api.v1',
            activeGroupId: data.activeGroupId || null,
            mcp: {
                host: this.host,
                port: this.port,
                enabled: true,
                boardToolsReady: this.boardToolsReady,
                allowedTools: [...this.allowedTools]
            }
        };
    }

    _getConfig() {
        const { data } = this._loadWithPlanService();
        return {
            config: {
                ...DEFAULT_MCP_CONFIG,
                ...(data.mcp || {}),
                host: '127.0.0.1',
                allowedTools: sanitizeAllowedTools(data.mcp?.allowedTools)
            },
            runtime: {
                host: this.host,
                port: this.port,
                enabled: Boolean(this.server),
                boardToolsReady: this.boardToolsReady,
                allowedTools: [...this.allowedTools]
            }
        };
    }

    _updateConfig(body) {
        const { data } = this._loadWithPlanService();
        const current = {
            ...DEFAULT_MCP_CONFIG,
            ...(data.mcp || {})
        };
        const next = {
            ...current,
            ...sanitizeConfigPatch(body || {})
        };
        next.host = '127.0.0.1';
        next.port = sanitizePort(next.port);
        next.allowedTools = sanitizeAllowedTools(next.allowedTools);
        data.mcp = next;
        this.allowedTools = new Set(next.allowedTools);
        this._saveAndNotify(data, 'mcp:config-updated', { bumpRevision: false });
        return {
            config: next,
            runtime: {
                host: this.host,
                port: this.port,
                enabled: Boolean(this.server),
                boardToolsReady: this.boardToolsReady,
                allowedTools: [...this.allowedTools]
            },
            requiresRestart: this.port !== next.port || next.enabled === false
        };
    }

    _context() {
        const { data, planService } = this._loadWithPlanService();
        const activeGroup = planService.getActiveGroup();
        return {
            context: planService.getAgentContext([]),
            viewport: data.viewport || { x: 0, y: 0, scale: 1 },
            itemCount: Array.isArray(data.items) ? data.items.length : 0,
            mcp: data.mcp || DEFAULT_MCP_CONFIG,
            activeGroup: activeGroup ? {
                id: activeGroup.id,
                name: activeGroup.name,
                folders: activeGroup.folders || [],
                defaultSaveFolder: activeGroup.defaultSaveFolder || null
            } : null
        };
    }

    _listPlans() {
        const { planService } = this._loadWithPlanService();
        return { plans: planService.listPlans() };
    }

    _getPlan(planId) {
        const { planService } = this._loadWithPlanService();
        const plan = planService.getPlan(planId);
        if (!plan) throw new Error(`Plan not found: ${planId}`);
        return { plan };
    }

    _createPlan(body) {
        const { data, planService } = this._loadWithPlanService();
        const plan = planService.createPlan(body || {});
        if (!plan) throw new Error('No active folder group for creating a plan');
        this._saveAndNotify(data, 'mcp:plan-created');
        return { plan };
    }

    _updatePlan(planId, body) {
        const { data, planService } = this._loadWithPlanService();
        const plan = planService.updatePlan(planId, body || {});
        if (!plan) throw new Error(`Plan not found: ${planId}`);
        this._saveAndNotify(data, 'mcp:plan-updated');
        return { plan };
    }

    _deletePlan(planId) {
        const { data, planService } = this._loadWithPlanService();
        const deleted = planService.deletePlan(planId);
        if (!deleted) throw new Error(`Plan not found: ${planId}`);
        this._saveAndNotify(data, 'mcp:plan-deleted');
        return { deleted: true };
    }

    _addRow(planId, body) {
        const { data, planService } = this._loadWithPlanService();
        const row = planService.addRow(planId, body || {});
        if (!row) throw new Error(`Plan not found: ${planId}`);
        this._saveAndNotify(data, 'mcp:plan-row-added');
        return { row, plan: planService.getPlan(planId) };
    }

    _updateRow(planId, rowId, body) {
        const { data, planService } = this._loadWithPlanService();
        const row = planService.updateRow(planId, rowId, body || {});
        if (!row) throw new Error(`Plan row not found: ${planId}/${rowId}`);
        this._saveAndNotify(data, 'mcp:plan-row-updated');
        return { row, plan: planService.getPlan(planId) };
    }

    _deleteRow(planId, rowId) {
        const { data, planService } = this._loadWithPlanService();
        const deleted = planService.deleteRow(planId, rowId);
        if (!deleted) throw new Error(`Plan row not found: ${planId}/${rowId}`);
        this._saveAndNotify(data, 'mcp:plan-row-deleted');
        return { deleted: true, plan: planService.getPlan(planId) };
    }

    _exportPlan(planId) {
        const { planService } = this._loadWithPlanService();
        const markdown = planService.exportPlanMarkdown(planId);
        if (!markdown) throw new Error(`Plan not found: ${planId}`);
        return { markdown };
    }

    async _addItem(body) {
        const filePath = body?.filePath ? String(body.filePath) : '';
        if (!filePath) throw new Error('Missing filePath');
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            throw new Error(`File does not exist: ${filePath}`);
        }
        const { data } = this._loadWithPlanService();
        const item = addBoardItem(data, filePath, body);
        this._saveAndNotify(data, 'mcp:item-added');
        return { item };
    }

    _listItems() {
        const { data } = this._loadWithPlanService();
        return {
            items: listBoardItems(data),
            itemCount: Array.isArray(data.items) ? data.items.length : 0
        };
    }

    _getItem(itemId) {
        const { data } = this._loadWithPlanService();
        const item = findBoardItem(data, itemId);
        if (!item) throw new Error(`Item not found: ${itemId}`);
        return { item: describeBoardItem(item) };
    }

    _updateItem(itemId, body) {
        const { data } = this._loadWithPlanService();
        const item = findBoardItem(data, itemId);
        if (!item) throw new Error(`Item not found: ${itemId}`);
        const patch = body || {};
        const oldItem = clone(item);
        if (patch.filePath !== undefined) {
            const filePath = String(patch.filePath || '').trim();
            if (!filePath) throw new Error('filePath cannot be empty');
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
                throw new Error(`File does not exist: ${filePath}`);
            }
            item.filePath = filePath;
            restoreRemovedBoardPath(data, filePath);
        }
        ['x', 'y', 'width', 'height'].forEach(key => {
            if (patch[key] !== undefined) {
                const value = Number(patch[key]);
                if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
                item[key] = value;
            }
        });
        const updatedReferences = syncPlanReferencesForItemUpdate(new PlanService(data), oldItem, item);
        syncActiveGroupItems(data);
        this._saveAndNotify(data, 'mcp:item-updated');
        return { item: describeBoardItem(item), updatedReferences };
    }

    _deleteItem(itemId) {
        const { data, planService } = this._loadWithPlanService();
        const item = findBoardItem(data, itemId);
        if (!item) throw new Error(`Item not found: ${itemId}`);
        markRemovedBoardPath(data, item.filePath);
        data.items = (data.items || []).filter(entry => entry.id !== itemId);
        const removedReferences = removePlanReferencesToItem(planService, item);
        syncActiveGroupItems(data);
        this._saveAndNotify(data, 'mcp:item-deleted');
        return {
            deleted: true,
            item: describeBoardItem(item),
            removedReferences
        };
    }

    async _generateImage(body) {
        return this.generateImageFromRenderer(body);
    }

    async _generateVideo(body) {
        return this.generateVideoFromRenderer(body);
    }

    async generateImageFromRenderer(body) {
        body = this._rememberGeneration('image', body);
        return this._runCancelableGeneration(body?.clientTaskId, signal =>
            this._generateImageFromRenderer(body, signal)
        );
    }

    async _generateImageFromRenderer(body, signal) {
        throwIfGenerationCanceled(signal);
        const prompt = String(body?.prompt || '').trim();
        if (!prompt) throw new Error('Missing prompt');
        const { data, planService } = this._loadWithPlanService();
        const requestedTargetDir = body?.targetDir || this.getDefaultSaveFolder?.(data) || this.getFallbackSaveDir?.();
        if (!requestedTargetDir) throw new Error('No save directory available for generated image');
        const targetInfo = resolveWritableTargetDir(requestedTargetDir, this.getFallbackSaveDir?.());
        const targetDir = targetInfo.targetDir;

        const sourceContext = collectImageSourceReferences(data, planService, body, {
            requireAll: body.provider !== 'builtin'
        });
        const generationOptions = await resolveImageGenerationOptions({
            ...body,
            sourceReferences: sourceContext.references
        });

        let result = null;
        if (body.provider !== 'builtin') {
            result = await tryGenerateWithOpenAI(prompt, targetDir, {
                ...generationOptions,
                signal,
                onRequestDiagnostic: diagnostic => this.recoveryStore.update(body.clientTaskId, {
                    requestDiagnostic: diagnostic,
                    ...(diagnostic.state ? { state: diagnostic.state } : {})
                }),
                onTaskSubmitted: ({ taskId, model, status, location }) => this._rememberSubmitted(body, {
                    clientTaskId: body.clientTaskId || null,
                    remoteTaskId: taskId,
                    targetDir,
                    model,
                    prompt,
                    kind: 'image',
                    status,
                    location,
                    createdAt: new Date().toISOString()
                }),
                onDownloaded: result => this._rememberResult(body, result)
            });
            if (!result?.success && (body.provider || body.providerConfig)) {
                throw new Error(result?.error || 'Image generation API failed');
            }
        }
        if (!result?.success) {
            throwIfGenerationCanceled(signal);
            result = await generateBuiltinPlaceholder(prompt, targetDir, generationOptions);
        }

        throwIfGenerationCanceled(signal);

        const committed = await this._commitBoardMutation(async () => {
            throwIfGenerationCanceled(signal);
            const { data: latestData, planService: latestPlanService } = this._loadWithPlanService();
            const shouldAddToCanvas = body.addToCanvas !== false
                && (result.provider !== 'builtin' || body.addToCanvas === true);
            const item = shouldAddToCanvas
                ? addBoardItem(latestData, result.filePath, {
                    x: body.x,
                    y: body.y,
                    width: Number.isFinite(body.canvasWidth) ? body.canvasWidth : result.width,
                    height: Number.isFinite(body.canvasHeight) ? body.canvasHeight : result.height,
                    generation: generationRecordFromRequest(
                        'image',
                        body,
                        prompt,
                        sourceContext.references,
                        result
                    )
                })
                : null;

            if (body.planId && body.rowId && item) {
                const generatedReference = {
                    itemId: item.id,
                    filePath: item.filePath,
                    name: path.basename(item.filePath),
                    kind: 'output'
                };
                const references = body.replaceReferences === true
                    ? [generatedReference]
                    : dedupeRowReferences([
                        ...((latestPlanService.getPlan(body.planId)?.rows || []).find(entry => entry.id === body.rowId)?.references || []),
                        generatedReference
                    ]);
                const row = latestPlanService.updateRow(body.planId, body.rowId, { references });
                if (!row) {
                    console.warn('[FlowCanvasBridge] generated image added, but row reference failed:', body.planId, body.rowId);
                }
            }

            if (item) this._saveAndNotify(latestData, 'mcp:image-generated');
            return {
                item,
                plan: body.planId ? latestPlanService.getPlan(body.planId) : null
            };
        });
        if (result.taskId) {
            this.notifyTaskCompleted?.({
                clientTaskId: body.clientTaskId || null,
                remoteTaskId: result.taskId,
                filePath: result.filePath
            });
        }
        return {
            item: committed.item,
            filePath: result.filePath,
            filePaths: Array.isArray(result.filePaths) && result.filePaths.length
                ? result.filePaths
                : [result.filePath].filter(Boolean),
            images: Array.isArray(result.images) ? result.images : [],
            midjourney: result.midjourney || null,
            mediaType: result.mediaType || 'image',
            provider: result.provider,
            taskId: result.taskId || null,
            image: {
                width: result.width,
                height: result.height
            },
            requestedSize: result.requestedSize || generationOptions.size || null,
            actualSize: result.actualSize || null,
            sizeMatchesRequest: result.sizeMatchesRequest,
            quality: generationOptions.quality,
            sourceReferences: sourceContext.references,
            missingSourceReferences: sourceContext.missing,
            plan: committed.plan,
            targetDir,
            requestedTargetDir,
            targetDirFallback: targetInfo.fallbackReason
        };
    }

    async generateVideoFromRenderer(body) {
        body = this._rememberGeneration('video', body);
        return this._runCancelableGeneration(body?.clientTaskId, signal =>
            this._generateVideoFromRenderer(body, signal)
        );
    }

    async _generateVideoFromRenderer(body, signal) {
        throwIfGenerationCanceled(signal);
        const prompt = String(body?.prompt || '').trim();
        if (!prompt) throw new Error('\u89c6\u9891\u63d0\u793a\u8bcd\u4e0d\u80fd\u4e3a\u7a7a');
        const { data, planService } = this._loadWithPlanService();
        const requestedTargetDir = body?.targetDir || this.getDefaultSaveFolder?.(data) || this.getFallbackSaveDir?.();
        if (!requestedTargetDir) throw new Error('\u6ca1\u6709\u53ef\u7528\u7684\u89c6\u9891\u4fdd\u5b58\u76ee\u5f55');
        const targetInfo = resolveWritableTargetDir(requestedTargetDir, this.getFallbackSaveDir?.());
        const targetDir = targetInfo.targetDir;
        const sourceContext = collectImageSourceReferences(data, planService, body);
        const videoSourceContext = collectVideoSourceReferences(data, body.videoReferences);
        const audioSourceContext = collectAudioSourceReferences(data, body.audioReferences);
        const result = await tryGenerateWithOpenAIVideo(prompt, targetDir, {
            ...body,
            signal,
            sourceReferences: sourceContext.references,
            videoReferences: videoSourceContext.references,
            audioReferences: audioSourceContext.references,
            onTaskSubmitted: ({ taskId, model, recovering, recovered }) => this._rememberSubmitted(body, {
                clientTaskId: body.clientTaskId || null,
                remoteTaskId: taskId,
                targetDir,
                model,
                prompt,
                recovering: recovering === true,
                recovered: recovered === true,
                createdAt: new Date().toISOString()
            }),
            onDownloaded: result => this._rememberResult(body, result),
            onProgress: (progress) => this.notifyVideoProgress?.({
                clientTaskId: body.clientTaskId || null,
                ...progress
            })
        });
        throwIfGenerationCanceled(signal);
        if (!result?.success) throw new Error(result?.error || '\u89c6\u9891\u751f\u6210 API \u8bf7\u6c42\u5931\u8d25');
        this.notifyTaskCompleted?.({
            clientTaskId: body.clientTaskId || null,
            remoteTaskId: result.taskId,
            filePath: result.filePath
        });

        const committed = await this._commitBoardMutation(async () => {
            throwIfGenerationCanceled(signal);
            const { data: latestData, planService: latestPlanService } = this._loadWithPlanService();
            const item = body.addToCanvas === false
                ? null
                : addBoardItem(latestData, result.filePath, {
                    x: body.x,
                    y: body.y,
                    width: Number.isFinite(body.canvasWidth) ? body.canvasWidth : result.width,
                    height: Number.isFinite(body.canvasHeight) ? body.canvasHeight : result.height,
                    generation: generationRecordFromRequest(
                        'video',
                        body,
                        prompt,
                        [
                            ...sourceContext.references,
                            ...videoSourceContext.references,
                            ...audioSourceContext.references
                        ],
                        result
                    )
                });

            if (body.planId && body.rowId && item) {
                const generatedReference = {
                    itemId: item.id,
                    filePath: item.filePath,
                    name: path.basename(item.filePath),
                    kind: 'output'
                };
                const references = body.replaceReferences === true
                    ? [generatedReference]
                    : dedupeRowReferences([
                        ...((latestPlanService.getPlan(body.planId)?.rows || []).find(entry => entry.id === body.rowId)?.references || []),
                        generatedReference
                    ]);
                latestPlanService.updateRow(body.planId, body.rowId, { references });
            }

            if (item) this._saveAndNotify(latestData, 'mcp:video-generated');
            return {
                item,
                plan: body.planId ? latestPlanService.getPlan(body.planId) : null
            };
        });
        return {
            item: committed.item,
            filePath: result.filePath,
            provider: result.provider,
            taskId: result.taskId,
            video: { url: result.url },
            sourceReferences: sourceContext.references,
            videoReferences: videoSourceContext.references,
            audioReferences: audioSourceContext.references,
            missingSourceReferences: [...sourceContext.missing, ...videoSourceContext.missing, ...audioSourceContext.missing],
            plan: committed.plan,
            targetDir,
            requestedTargetDir,
            targetDirFallback: targetInfo.fallbackReason
        };
    }

    async compressVideoReferenceImagesFromRenderer(body) {
        const { data, planService } = this._loadWithPlanService();
        const sourceContext = collectImageSourceReferences(data, planService, body);
        const references = sourceContext.references.slice(0, 9);
        if (references.length === 0) throw new Error('\u6ca1\u6709\u53ef\u538b\u7f29\u7684\u53c2\u8003\u56fe\u7247');

        const addToCanvas = body?.addToCanvas !== false;
        const temporaryTargetDir = path.join(app.getPath('userData'), 'data', 'reference-cache');
        const requestedTargetDir = addToCanvas
            ? (body?.targetDir || this.getDefaultSaveFolder?.(data) || this.getFallbackSaveDir?.())
            : temporaryTargetDir;
        if (!requestedTargetDir) throw new Error('\u6ca1\u6709\u53ef\u7528\u7684\u538b\u7f29\u56fe\u7247\u4fdd\u5b58\u76ee\u5f55');
        if (!addToCanvas) await fs.promises.mkdir(temporaryTargetDir, { recursive: true });
        const targetInfo = resolveWritableTargetDir(requestedTargetDir, this.getFallbackSaveDir?.());
        const targetDir = targetInfo.targetDir;
        const requestedBudgetBytes = Number(body?.uploadBudgetBytes);
        const uploadBudgetBytes = Number.isFinite(requestedBudgetBytes)
            ? Math.max(2 * 1024 * 1024, Math.min(VIDEO_REFERENCE_UPLOAD_BUDGET_BYTES, Math.floor(requestedBudgetBytes)))
            : VIDEO_REFERENCE_UPLOAD_BUDGET_BYTES;
        const minimumTargetBytes = uploadBudgetBytes <= 2 * 1024 * 1024
            ? 384 * 1024
            : 768 * 1024;
        const targetBytes = Math.max(
            minimumTargetBytes,
            Math.min(VIDEO_REFERENCE_MAX_OUTPUT_BYTES, Math.floor(uploadBudgetBytes / references.length))
        );
        const outputs = [];

        for (const reference of references) {
            const sourcePath = String(reference.filePath || '');
            const originalBytes = fs.statSync(sourcePath).size;
            if (originalBytes <= targetBytes) continue;

            let compressed;
            let filePath;
            let metadata;
            let referenceId = null;
            let cacheReused = false;
            if (addToCanvas) {
                compressed = await compressVideoReferenceImage(sourcePath, targetBytes);
                const extension = compressed.mimeType === 'image/webp' ? '.webp' : '.jpg';
                filePath = path.join(
                    targetDir,
                    uniqueImageName('flow_compressed', path.basename(sourcePath, path.extname(sourcePath)), extension)
                );
                await fs.promises.writeFile(filePath, compressed.buffer);
                metadata = await sharp(compressed.buffer).metadata();
            } else {
                const cached = await getReferenceCache().getOrCreateCompressed({
                    sourcePath,
                    targetBytes,
                    compress: async () => {
                        const output = await compressVideoReferenceImage(sourcePath, targetBytes);
                        const outputMetadata = await sharp(output.buffer).metadata();
                        return {
                            ...output,
                            width: outputMetadata.width || null,
                            height: outputMetadata.height || null
                        };
                    }
                });
                compressed = { buffer: null, mimeType: cached.mimeType };
                filePath = cached.filePath;
                metadata = { width: cached.width, height: cached.height };
                referenceId = cached.referenceId;
                cacheReused = cached.cacheReused;
            }
            const sourceItem = findBoardItem(data, reference.itemId)
                || (data.items || []).find(item => normalizeFsPath(item.filePath) === normalizeFsPath(sourcePath));
            const sourceWidth = Number(sourceItem?.width);
            const sourceHeight = Number(sourceItem?.height);
            const item = addToCanvas
                ? addBoardItem(data, filePath, {
                    x: Number.isFinite(sourceItem?.x)
                        ? sourceItem.x + (Number.isFinite(sourceWidth) ? sourceWidth : 320) + 40
                        : undefined,
                    y: Number.isFinite(sourceItem?.y) ? sourceItem.y : undefined,
                    width: Number.isFinite(sourceWidth) ? sourceWidth : undefined,
                    height: Number.isFinite(sourceHeight) ? sourceHeight : undefined
                })
                : null;
            outputs.push({
                sourceItemId: reference.itemId || null,
                sourceFilePath: sourcePath,
                item: item ? describeBoardItem(item) : null,
                filePath,
                originalBytes,
                compressedBytes: compressed.buffer?.length || fs.statSync(filePath).size,
                width: metadata.width || null,
                height: metadata.height || null,
                referenceId,
                cacheReused
            });
        }

        if (outputs.length === 0) {
            throw new Error('\u53c2\u8003\u56fe\u5df2\u7b26\u5408\u4e0a\u4f20\u5927\u5c0f\uff0c\u65e0\u9700\u538b\u7f29');
        }
        if (addToCanvas) this._saveAndNotify(data, 'mcp:image-compressed');
        return {
            outputs,
            addToCanvas,
            temporary: !addToCanvas,
            missingSourceReferences: sourceContext.missing,
            targetDir,
            requestedTargetDir,
            targetDirFallback: targetInfo.fallbackReason
        };
    }

    async resumeVideoFromRenderer(body) {
        this.canceledGenerationRequests.delete(String(body?.clientTaskId || ''));
        return this._runCancelableGeneration(body?.clientTaskId, signal =>
            this._resumeVideoFromRenderer(body, signal)
        );
    }

    async resumeImageFromRenderer(body) {
        this.canceledGenerationRequests.delete(String(body?.clientTaskId || ''));
        return this._runCancelableGeneration(body.clientTaskId, signal => this._resumeImageFromRenderer(body, signal));
    }

    async _resumeImageFromRenderer(body, signal) {
            const config = body.providerConfig || {};
            if (!body.taskId || !config.apiKey || !config.endpoint) throw new Error('图片恢复参数不完整');
            const requestedTargetDir = body.targetDir || this.getFallbackSaveDir?.();
            if (!requestedTargetDir) throw new Error('没有可用的图片保存目录');
            const { targetDir } = resolveWritableTargetDir(requestedTargetDir, this.getFallbackSaveDir?.());
            const endpoint = buildOpenAiImageEndpoint(config.endpoint, 'generations');
            const completed = await pollOpenAiImageTask(endpoint, config.apiKey, body.taskId,
                { id: body.taskId, status: 'pending' }, { model: config.model, signal, location: body.location,
                    onProgress: progress => this.notifyVideoProgress?.({ clientTaskId: body.clientTaskId, ...progress }),
                    nativeMidjourney: shouldUseNativeMidjourneyRoute(config.model, config.endpoint) });
            const entries = getGeneratedImageDataList(completed.payload);
            if (!entries.length && completed.image) entries.push(completed.image);
            const saved = (await Promise.all(entries.map(entry => saveGeneratedImage(entry, endpoint,
                targetDir, body.prompt, config.apiKey, signal)))).filter(Boolean);
            if (!saved.length) throw new Error('图片任务没有返回可保存的结果');
            let outputs = saved;
            if (isMidjourneyImagineModel(config.model) && saved.length === 1 && saved[0].mediaType === 'image') {
                const split = await splitMidjourneyGrid(saved[0]);
                if (split.length === 4) outputs = split;
            }
            const result = { filePath: outputs[0].filePath, filePaths: outputs.map(output => output.filePath),
                images: outputs, mediaType: outputs[0].mediaType || 'image', taskId: body.taskId, targetDir };
            this._rememberResult(body, result);
            return result;
    }

    async _resumeVideoFromRenderer(body, signal) {
        throwIfGenerationCanceled(signal);
        const taskId = String(body?.taskId || '').trim();
        if (!taskId) throw new Error('\u7f3a\u5c11\u53ef\u6062\u590d\u7684\u89c6\u9891\u4efb\u52a1 ID');
        const prompt = String(body?.prompt || '').trim();
        const providerConfig = body?.providerConfig || {};
        const apiKey = String(providerConfig.apiKey || process.env.FLOW_CANVAS_VIDEO_API_KEY || '').trim();
        const model = String(providerConfig.model || body?.model || process.env.FLOW_CANVAS_VIDEO_MODEL || '').trim();
        const endpoint = buildVideoGenerationEndpoint(
            providerConfig.endpoint || process.env.FLOW_CANVAS_VIDEO_ENDPOINT,
            model
        );
        if (!apiKey) throw new Error('\u672a\u914d\u7f6e\u89c6\u9891 API Key');
        if (!endpoint) throw new Error('\u672a\u914d\u7f6e\u89c6\u9891 API \u5730\u5740');

        const { data } = this._loadWithPlanService();
        const requestedTargetDir = body?.targetDir || this.getDefaultSaveFolder?.(data) || this.getFallbackSaveDir?.();
        if (!requestedTargetDir) throw new Error('\u6ca1\u6709\u53ef\u7528\u7684\u89c6\u9891\u4fdd\u5b58\u76ee\u5f55');
        const targetInfo = resolveWritableTargetDir(requestedTargetDir, this.getFallbackSaveDir?.());
        const targetDir = targetInfo.targetDir;
        const completed = await pollOpenAiVideoTask(
            endpoint,
            apiKey,
            taskId,
            { id: taskId, task_id: taskId, status: 'pending', recovering: true },
            {
                model,
                signal,
                preferVideoTaskEndpoint: isMiniMaxH3Model(model) || isSeedance25Model(model),
                onTaskIdResolved: (resolvedTaskId) => this._rememberSubmitted(body, {
                    clientTaskId: body.clientTaskId || null,
                    remoteTaskId: resolvedTaskId,
                    targetDir,
                    model,
                    prompt,
                    recovered: true,
                    createdAt: new Date().toISOString()
                }),
                onProgress: (progress) => this.notifyVideoProgress?.({
                    clientTaskId: body.clientTaskId || null,
                    ...progress
                })
            }
        );
        throwIfGenerationCanceled(signal);
        const resolvedTaskId = completed.taskId || taskId;
        this.notifyVideoProgress?.({ clientTaskId: body.clientTaskId || null, stage: 'download' });
        const filePath = await downloadVideo(completed.url, targetDir, prompt, model, signal);
        this._rememberResult(body, { filePath, filePaths: [filePath], taskId: resolvedTaskId,
            mediaType: 'video', video: { url: completed.url }, targetDir });
        throwIfGenerationCanceled(signal);
        this.notifyVideoProgress?.({ clientTaskId: body.clientTaskId || null, stage: 'completed' });
        if (body.addToCanvas !== false) this.notifyTaskCompleted?.({ clientTaskId: body.clientTaskId, remoteTaskId: resolvedTaskId, filePath });
        const item = body.addToCanvas === false
            ? null
            : addBoardItem(data, filePath, {
                x: body.x,
                y: body.y,
                width: body.canvasWidth,
                height: body.canvasHeight,
                generation: generationRecordFromRequest('video', {
                    ...body,
                    providerConfig: { ...providerConfig, model }
                }, prompt, [], { taskId: resolvedTaskId })
            });
        if (item) this._saveAndNotify(data, 'mcp:video-recovered');
        return {
            item,
            filePath,
            provider: 'openai-video',
            taskId: resolvedTaskId,
            video: { url: completed.url },
            targetDir,
            requestedTargetDir,
            targetDirFallback: targetInfo.fallbackReason
        };
    }

    _sendJson(res, statusCode, payload) {
        res.statusCode = statusCode;
        res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (statusCode === 204) {
            res.end();
            return;
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload == null ? {} : payload));
    }
}

function generationRecordFromRequest(kind, body = {}, prompt = '', references = [], result = {}) {
    const providerConfig = body.providerConfig || {};
    const model = String(providerConfig.model || body.model || '').trim();
    const baseConfig = {
        prompt: String(prompt || ''),
        providerId: providerConfig.id || null,
        sourceProviderId: providerConfig.sourceProviderId || providerConfig.id || null,
        model
    };
    const config = kind === 'video'
        ? {
            ...baseConfig,
            resolution: body.resolution || '',
            ratio: body.ratio || '',
            duration: body.duration ?? '',
            cameraFixed: body.cameraFixed === true,
            generateAudio: body.generateAudio === true,
            webSearch: body.webSearch === true,
            watermark: body.watermark === true
        }
        : {
            ...baseConfig,
            size: body.size || '',
            ratio: body.midjourney?.ratio || '',
            quality: body.quality || '',
            responseFormat: body.responseFormat || '',
            historyDisabled: body.historyDisabled !== false,
            stream: body.stream === true,
            webSearch: body.webSearch === true,
            count: Number(body.n) || 1,
            ...(body.midjourney && typeof body.midjourney === 'object' ? {
                midjourneyVersion: body.midjourney.version || '',
                midjourneyRaw: body.midjourney.raw === true,
                midjourneyStylize: body.midjourney.stylize ?? '',
                midjourneyChaos: body.midjourney.chaos ?? ''
            } : {})
        };
    return {
        nodeType: kind,
        title: kind === 'video' ? '视频生成' : '图片生成',
        prompt: String(prompt || ''),
        config,
        model,
        providerId: providerConfig.id || null,
        sourceProviderId: providerConfig.sourceProviderId || providerConfig.id || null,
        references: (Array.isArray(references) ? references : []).map(reference => ({
            itemId: reference?.itemId || reference?.id || null,
            filePath: reference?.filePath || ''
        })),
        taskId: result?.taskId || null,
        generatedAt: Date.now(),
        directWorkspace: true
    };
}

function addBoardItem(data, filePath, options = {}) {
    if (!Array.isArray(data.items)) data.items = [];
    restoreRemovedBoardPath(data, filePath);
    const existing = data.items.find(item => item.filePath === filePath);
    if (existing) {
        if (options.generation && typeof options.generation === 'object') {
            existing.generation = clone(options.generation);
        }
        if (options.fromNodeId) existing.fromNodeId = options.fromNodeId;
        if (Number.isFinite(options.width) && !Number.isFinite(existing.width)) {
            existing.width = options.width;
        }
        if (Number.isFinite(options.height) && !Number.isFinite(existing.height)) {
            existing.height = options.height;
        }
        return existing;
    }

    const viewport = data.viewport || { x: 0, y: 0, scale: 1 };
    const scale = Number.isFinite(viewport.scale) && viewport.scale > 0 ? viewport.scale : 1;
    const defaultX = (-viewport.x / scale) + 160;
    const defaultY = (-viewport.y / scale) + 160;
    const item = {
        id: makeId('item'),
        filePath,
        x: Number.isFinite(options.x) ? options.x : defaultX,
        y: Number.isFinite(options.y) ? options.y : defaultY,
        width: Number.isFinite(options.width) ? options.width : undefined,
        height: Number.isFinite(options.height) ? options.height : undefined,
        generation: options.generation && typeof options.generation === 'object'
            ? clone(options.generation)
            : undefined,
        fromNodeId: options.fromNodeId || undefined,
        addedAt: Date.now()
    };
    Object.keys(item).forEach(key => item[key] === undefined && delete item[key]);
    data.items.push(item);

    const activeGroup = (data.folderGroups || []).find(group => group.id === data.activeGroupId);
    if (activeGroup) {
        activeGroup.savedItems = clone(data.items);
        activeGroup.savedViewport = clone(data.viewport || { x: 0, y: 0, scale: 1 });
    }
    return item;
}

function listBoardItems(data) {
    return (Array.isArray(data.items) ? data.items : []).map(describeBoardItem);
}

function findBoardItem(data, itemId) {
    const id = String(itemId || '');
    if (!id) return null;
    return (Array.isArray(data.items) ? data.items : []).find(item => item.id === id) || null;
}

function describeBoardItem(item) {
    const filePath = String(item?.filePath || '');
    return {
        id: item.id,
        filePath,
        name: path.basename(filePath),
        type: getBoardItemType(filePath),
        exists: filePath ? fs.existsSync(filePath) : false,
        x: Number.isFinite(item.x) ? item.x : 0,
        y: Number.isFinite(item.y) ? item.y : 0,
        width: Number.isFinite(item.width) ? item.width : null,
        height: Number.isFinite(item.height) ? item.height : null,
        addedAt: item.addedAt || null
    };
}

function getBoardItemType(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext) || ext === '.gif' || ext === '.bmp' || ext === '.tif' || ext === '.tiff' || ext === '.svg' || ext === '.ico') return 'image';
    if (['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v'].includes(ext)) return 'video';
    if (['.mp3', '.wav', '.aac', '.flac', '.ogg', '.wma', '.m4a'].includes(ext)) return 'audio';
    if (['.pdf', '.doc', '.docx', '.txt', '.ppt', '.pptx', '.xls', '.xlsx'].includes(ext)) return 'document';
    return 'other';
}

function syncActiveGroupItems(data) {
    const activeGroup = (data.folderGroups || []).find(group => group.id === data.activeGroupId);
    if (!activeGroup) return;
    activeGroup.savedItems = clone(data.items || []);
    activeGroup.savedViewport = clone(data.viewport || { x: 0, y: 0, scale: 1 });
}

function bumpBoardRevision(data) {
    const activeGroup = (data.folderGroups || []).find(group => group.id === data.activeGroupId) || null;
    const current = Number(activeGroup?.boardRevision ?? data.boardRevision);
    const next = (Number.isInteger(current) && current >= 0 ? current : 0) + 1;
    data.boardRevision = next;
    if (activeGroup) activeGroup.boardRevision = next;
    return next;
}

function getRemovedBoardPathOwner(data) {
    return (data.folderGroups || []).find(group => group.id === data.activeGroupId) || data;
}

function markRemovedBoardPath(data, filePath) {
    const owner = getRemovedBoardPathOwner(data);
    const normalizedPath = normalizeFsPath(filePath);
    if (!owner || !normalizedPath) return;
    owner.removedFromBoardPaths = [...new Set([
        ...(Array.isArray(owner.removedFromBoardPaths) ? owner.removedFromBoardPaths : [])
            .map(normalizeFsPath)
            .filter(Boolean),
        normalizedPath
    ])];
}

function restoreRemovedBoardPath(data, filePath) {
    const owner = getRemovedBoardPathOwner(data);
    const normalizedPath = normalizeFsPath(filePath);
    if (!owner || !normalizedPath) return;
    owner.removedFromBoardPaths = (Array.isArray(owner.removedFromBoardPaths)
        ? owner.removedFromBoardPaths
        : [])
        .map(normalizeFsPath)
        .filter(pathKey => pathKey && pathKey !== normalizedPath);
}

function removePlanReferencesToItem(planService, item) {
    const removed = [];
    const itemPathKey = normalizeFsPath(item.filePath);
    (planService.listPlans() || []).forEach(plan => {
        (plan.rows || []).forEach(row => {
            const before = row.references || [];
            const kept = before.filter(reference => {
                const sameItem = item.id && reference.itemId === item.id;
                const samePath = itemPathKey && normalizeFsPath(reference.filePath) === itemPathKey;
                return !sameItem && !samePath;
            });
            if (kept.length === before.length) return;
            planService.updateRow(plan.id, row.id, { references: kept });
            removed.push({
                planId: plan.id,
                rowId: row.id,
                count: before.length - kept.length
            });
        });
    });
    return removed;
}

function syncPlanReferencesForItemUpdate(planService, oldItem, nextItem) {
    const updated = [];
    const oldPathKey = normalizeFsPath(oldItem.filePath);
    (planService.listPlans() || []).forEach(plan => {
        (plan.rows || []).forEach(row => {
            let changed = false;
            const references = (row.references || []).map(reference => {
                const sameItem = nextItem.id && reference.itemId === nextItem.id;
                const samePath = oldPathKey && normalizeFsPath(reference.filePath) === oldPathKey;
                if (!sameItem && !samePath) return reference;
                changed = true;
                return {
                    ...reference,
                    itemId: nextItem.id,
                    filePath: nextItem.filePath,
                    name: path.basename(nextItem.filePath)
                };
            });
            if (!changed) return;
            planService.updateRow(plan.id, row.id, { references });
            updated.push({ planId: plan.id, rowId: row.id });
        });
    });
    return updated;
}

function collectImageSourceReferences(data, planService, body = {}, { requireAll = false } = {}) {
    const requested = Array.isArray(body.sourceReferences) ? body.sourceReferences : [];
    const references = [];
    const missing = [];
    const pushReference = reference => {
        const normalized = normalizeSourceReference(reference, data);
        if (!normalized) {
            if (requireAll) missing.push({ name: '未找到路径的参考素材' });
            return;
        }
        if (!requireAll && references.some(existing => normalizeFsPath(existing.filePath) === normalizeFsPath(normalized.filePath))) return;
        if (isSupportedSourceImage(normalized.filePath) && fs.existsSync(normalized.filePath)) {
            references.push(normalized);
        } else {
            missing.push(normalized);
        }
    };

    requested.forEach(pushReference);

    if (body.planId && body.rowId) {
        const plan = planService.getPlan(body.planId);
        const row = plan?.rows?.find(entry => entry.id === body.rowId);
        (row?.references || []).forEach(pushReference);
        const shouldIncludePlanAssets = body.includePlanAssets === true || ((row?.references || []).length === 0 && body.includePlanAssets !== false);
        if (shouldIncludePlanAssets) {
            plan?.rows?.forEach(entry => {
                if (entry.id !== body.rowId) (entry.references || []).forEach(pushReference);
            });
        }
    }

    if (requireAll && missing.length) {
        throw new Error(`参考图文件不存在或无法读取：${missing.map(reference => reference.name).join('、')}。已阻止编辑请求，请重新选择参考图后再试。`);
    }
    return { references, missing };
}

async function resolveImageGenerationOptions(options = {}) {
    const requestedSize = String(options.size || '').trim().replace(/\u00d7/g, 'x');
    const requestedQuality = String(options.quality || '').trim().toLowerCase();
    const quality = ['auto', 'low', 'medium', 'high'].includes(requestedQuality)
        ? requestedQuality
        : 'high';
    if (requestedSize) return { ...options, size: requestedSize, quality };

    const marker = `${options?.providerConfig?.endpoint || ''} ${options?.providerConfig?.name || ''}`.toLowerCase();
    const candidates = /ai\.ravenhash\.org|ravenhash/.test(marker)
        ? RAVENHASH_IMAGE_SIZE_OPTIONS
        : DEFAULT_IMAGE_SIZE_OPTIONS;
    const referenceAspect = await resolveLargestReferenceAspect(options.sourceReferences);
    const size = chooseLargestClosestImageSize(candidates, referenceAspect);
    return { ...options, size, quality };
}

async function resolveLargestReferenceAspect(references = []) {
    let selected = null;
    for (const reference of Array.isArray(references) ? references : []) {
        try {
            const metadata = await sharp(reference.filePath).rotate().metadata();
            const width = Number(metadata.width) || 0;
            const height = Number(metadata.height) || 0;
            const area = width * height;
            if (width > 0 && height > 0 && (!selected || area > selected.area)) {
                selected = { area, aspect: width / height };
            }
        } catch (_) {
            // Ignore a reference whose metadata cannot be inspected.
        }
    }
    return selected?.aspect || null;
}

function chooseLargestClosestImageSize(candidates = [], referenceAspect = null) {
    const parsed = candidates.map(value => {
        const match = String(value).match(/^(\d+)x(\d+)$/i);
        if (!match) return null;
        const width = Number(match[1]);
        const height = Number(match[2]);
        return { value, width, height, area: width * height, aspect: width / height };
    }).filter(Boolean);
    parsed.sort((left, right) => {
        const leftDistance = referenceAspect ? Math.abs(Math.log(left.aspect / referenceAspect)) : 0;
        const rightDistance = referenceAspect ? Math.abs(Math.log(right.aspect / referenceAspect)) : 0;
        if (Math.abs(leftDistance - rightDistance) > 0.0001) return leftDistance - rightDistance;
        if (left.area !== right.area) return right.area - left.area;
        return right.width - left.width;
    });
    return parsed[0]?.value || '1024x1024';
}

function collectVideoSourceReferences(data, requested = []) {
    const references = [];
    const missing = [];
    (Array.isArray(requested) ? requested : []).forEach(reference => {
        const normalized = normalizeSourceReference(reference, data);
        if (!normalized) return;
        if (references.some(existing => normalizeFsPath(existing.filePath) === normalizeFsPath(normalized.filePath))) return;
        if (VIDEO_EXTENSIONS.has(path.extname(normalized.filePath).toLowerCase()) && fs.existsSync(normalized.filePath)) {
            references.push(normalized);
        } else {
            missing.push(normalized);
        }
    });
    return { references: references.slice(0, 3), missing };
}

function collectAudioSourceReferences(data, requested = []) {
    const references = [];
    const missing = [];
    (Array.isArray(requested) ? requested : []).forEach(reference => {
        const normalized = normalizeSourceReference(reference, data);
        if (!normalized) return;
        if (references.some(existing => normalizeFsPath(existing.filePath) === normalizeFsPath(normalized.filePath))) return;
        if (AUDIO_EXTENSIONS.has(path.extname(normalized.filePath).toLowerCase()) && fs.existsSync(normalized.filePath)) {
            references.push(normalized);
        } else {
            missing.push(normalized);
        }
    });
    return { references: references.slice(0, 3), missing };
}

function normalizeSourceReference(reference, data) {
    if (!reference) return null;
    if (typeof reference === 'string') {
        return {
            itemId: '',
            filePath: reference,
            name: path.basename(reference),
            kind: 'source'
        };
    }
    const itemId = reference.itemId ? String(reference.itemId) : '';
    const item = itemId ? (data.items || []).find(entry => entry.id === itemId) : null;
    const filePath = String(reference.filePath || item?.filePath || '').trim();
    if (!filePath) return null;
    return {
        itemId,
        filePath,
        name: String(reference.name || path.basename(filePath)).trim(),
        kind: reference.kind ? String(reference.kind) : (reference.role ? String(reference.role) : 'source'),
        referenceId: reference.referenceId ? String(reference.referenceId) : null
    };
}

function toRowReference(reference) {
    return {
        itemId: reference.itemId || '',
        filePath: reference.filePath,
        name: reference.name || path.basename(reference.filePath),
        kind: reference.kind || 'source',
        referenceId: reference.referenceId || null
    };
}

function dedupeRowReferences(references) {
    const seen = new Set();
    return references.filter(reference => {
        const key = normalizeFsPath(reference.filePath);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function isSupportedSourceImage(filePath) {
    return IMAGE_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

function normalizeFsPath(filePath) {
    const raw = String(filePath || '');
    if (!raw) return '';
    const normalized = path.normalize(raw).normalize('NFC');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function buildOpenAiImageEndpoint(endpoint, mode = 'generations') {
    const raw = String(endpoint || '').trim() || 'https://api.openai.com/v1/images/generations';
    const route = mode === 'edits' ? 'edits' : 'generations';
    try {
        const url = new URL(raw);
        let pathName = url.pathname.replace(/\/+$/, '');
        if (!pathName || pathName === '/') {
            pathName = `/v1/images/${route}`;
        } else if (/\/v1$/i.test(pathName)) {
            pathName += `/images/${route}`;
        } else if (/\/(?:chat\/completions|responses|completions|models|images\/(?:generations|edits))$/i.test(pathName)) {
            pathName = pathName.replace(/\/(?:chat\/completions|responses|completions|models|images\/(?:generations|edits))$/i, `/images/${route}`);
        } else if (!new RegExp(`/images/${route}$`, 'i').test(pathName)) {
            pathName += `/images/${route}`;
        }
        url.pathname = pathName;
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch (_) {
        return raw;
    }
}

function decodeImageBase64(value) {
    const source = String(value || '').trim();
    if (!source) return null;
    const commaIndex = source.indexOf(',');
    if (/^data:image\//i.test(source) && commaIndex >= 0) {
        return Buffer.from(source.slice(commaIndex + 1).replace(/\s+/g, ''), 'base64');
    }
    return Buffer.from(source.replace(/\s+/g, ''), 'base64');
}

async function resolveGeneratedImageBuffer(image, endpoint, apiKey = '', signal = null) {
    const base64Value = String(
        image?.b64_json
        || image?.base64
        || image?.image_base64
        || image?.base64_image
        || ''
    ).trim();
    if (base64Value) return decodeImageBase64(base64Value);

    const sourceValue = image?.url?.url || image?.url || image?.image_url?.url || image?.image_url;
    const source = String(sourceValue || '').trim();
    if (!source) return null;

    if (/^data:/i.test(source)) {
        const commaIndex = source.indexOf(',');
        if (commaIndex < 0) throw new Error('Image API returned an invalid Data URL');
        const metadata = source.slice(0, commaIndex);
        const payload = source.slice(commaIndex + 1);
        return /;base64(?:;|$)/i.test(metadata)
            ? Buffer.from(payload.replace(/\s+/g, ''), 'base64')
            : Buffer.from(decodeURIComponent(payload), 'utf8');
    }

    if (source.length > 512 && /^[A-Za-z0-9+/=\s]+$/.test(source)) {
        return Buffer.from(source.replace(/\s+/g, ''), 'base64');
    }

    let imageUrl;
    try {
        imageUrl = new URL(source, endpoint).toString();
    } catch (_) {
        throw new Error(`Image API returned an invalid image URL: ${source.slice(0, 160)}`);
    }
    const requestHeaders = { Accept: 'image/*, application/octet-stream' };
    try {
        const endpointOrigin = new URL(endpoint).origin;
        const imageOrigin = new URL(imageUrl).origin;
        if (apiKey && endpointOrigin === imageOrigin) {
            requestHeaders.Authorization = `Bearer ${apiKey}`;
        }
    } catch (_) {
        // Keep the download unauthenticated if either URL is malformed.
    }
    const { buffer } = await downloadGeneratedBuffer(imageUrl, { headers: requestHeaders, signal });
    return buffer;
}

async function saveGeneratedImage(image, endpoint, targetDir, prompt, apiKey = '', signal = null) {
    const buffer = await resolveGeneratedImageBuffer(image, endpoint, apiKey, signal);
    if (!buffer) return null;
    const metadata = await sharp(buffer).metadata().catch(() => ({}));
    const source = image?.url?.url || image?.url || image?.image_url?.url || image?.image_url || '';
    const contentType = image?.content_type || image?.contentType || image?.mime_type || image?.mimeType || '';
    const media = describeGeneratedMedia(buffer, metadata, { source, contentType });
    if (media.mediaType === 'image' && !metadata.width) throw new Error('产物下载地址未返回有效图片，可稍后重新拉取');
    const filePath = path.join(targetDir, uniqueImageName('ai', prompt, media.extension));
    fs.writeFileSync(filePath, buffer);
    return {
        filePath,
        width: metadata.width || 1024,
        height: metadata.height || 1024,
        format: metadata.format || null,
        mediaType: media.mediaType
    };
}

async function splitMidjourneyGrid(gridImage) {
    const regions = midjourneyGridRegions(gridImage?.width, gridImage?.height);
    if (regions.length !== 4 || !gridImage?.filePath) return [];
    const parsed = path.parse(gridImage.filePath);
    const source = sharp(gridImage.filePath);
    return Promise.all(regions.map(async (region, index) => {
        const filePath = path.join(parsed.dir, `${parsed.name}_U${index + 1}${parsed.ext || '.png'}`);
        await source.clone().extract(region).toFile(filePath);
        return {
            filePath,
            width: region.width,
            height: region.height,
            candidateIndex: index + 1
        };
    }));
}

async function pollOpenAiImageTask(generationEndpoint, apiKey, taskId, initialPayload, options = {}) {
    const standardEndpoint = buildImageTaskEndpoint(generationEndpoint, taskId, options.location);
    const genericEndpoint = new URL(generationEndpoint);
    genericEndpoint.pathname = genericEndpoint.pathname.replace(/\/images\/(generations|edits)\/?$/i, '/tasks') + `/${encodeURIComponent(taskId)}`;
    genericEndpoint.search = '';
    const midjourneyEndpoint = buildMidjourneyTaskEndpoint(generationEndpoint, taskId);
    const taskEndpoints = (options.nativeMidjourney
        ? [midjourneyEndpoint]
        : [
            standardEndpoint,
            genericEndpoint.toString(),
            ...(isMidjourneyImageModel(options.model) ? [midjourneyEndpoint] : [])
        ]).filter((value, index, values) => values.indexOf(value) === index);
    let taskEndpointIndex = 0;
    const deadline = Date.now() + 16 * 60 * 1000;
    let payload = initialPayload;
    let retryDelay = imageTaskRetryDelayMs(options.retryAfter);
    let consecutiveConnectionFailures = 0;
    let transientFailures = 0;
    let emptyCompleted = 0;
    let queried = false;
    const wait = options.wait || sleep;
    const fetchTask = options.fetchTask || fetchTextWithRetry;

    while (Date.now() < deadline) {
        const currentImage = getGeneratedImageData(payload);
        if (currentImage) return { image: currentImage, payload, taskId };

        const status = imageTaskStatus(payload);
        if (isFailedImageTaskStatus(status)) {
            const reason = imageTaskErrorMessage(payload) || '服务器未提供失败原因';
            throw new Error(`图片生成任务失败：${reason}`);
        }
        if (isCompletedImageTaskStatus(status)) {
            if (++emptyCompleted > 12) throw new Error(`图片任务 ${taskId} 已完成，但上游尚未返回产物地址；可稍后再次拉取`);
        }

        options.onProgress?.({ stage: emptyCompleted ? 'ready' : 'recovering', remoteStatus: status });
        if (queried) await wait(retryDelay, options.signal);
        queried = true;
        throwIfGenerationCanceled(options.signal);
        let response;
        let text;
        try {
            let taskEndpoint = taskEndpoints[taskEndpointIndex];
            ({ response, text } = await fetchTask(taskEndpoint, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    Accept: 'application/json'
                },
                redirect: 'follow',
                signal: options.signal
            }, '查询图片任务状态'));
            if ([404, 405].includes(response.status) && taskEndpointIndex < taskEndpoints.length - 1) {
                taskEndpointIndex += 1;
                taskEndpoint = taskEndpoints[taskEndpointIndex];
                ({ response, text } = await fetchTask(taskEndpoint, {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        Accept: 'application/json'
                    },
                    redirect: 'follow',
                    signal: options.signal
                }, '查询 Midjourney 图片任务状态'));
            }
            consecutiveConnectionFailures = 0;
        } catch (error) {
            throwIfGenerationCanceled(options.signal);
            consecutiveConnectionFailures += 1;
            if (consecutiveConnectionFailures < 8) {
                options.onProgress?.({ stage: 'recovering', retryCount: consecutiveConnectionFailures, lastError: error.message });
                console.warn('[FlowCanvasBridge] Image task polling interrupted; retrying:', error.message);
                continue;
            }
            throw error;
        }

        if ([408, 425, 429, 500, 502, 503, 504, 404].includes(response.status) && ++transientFailures <= 24) {
            retryDelay = Math.min(30000, 2000 * transientFailures);
            if (response.status === 404) taskEndpointIndex = (taskEndpointIndex + 1) % taskEndpoints.length;
            options.onProgress?.({ stage: 'recovering', retryCount: transientFailures, lastError: `HTTP ${response.status}` });
            continue;
        }
        if (!response.ok) {
            const taskEndpoint = taskEndpoints[taskEndpointIndex];
            throw new Error(`查询图片任务失败（${describeRemoteEndpoint(taskEndpoint)}）：HTTP ${response.status} ${text.slice(0, 1000)}`);
        }
        payload = parseImageApiResponseText(text, response.headers.get('content-type'));
        if (!payload) {
            if (++transientFailures <= 24) continue;
            throw new Error(`查询图片任务 ${taskId} 时，服务器持续返回无效 JSON；可稍后再次拉取`);
        }
        transientFailures = 0;
        retryDelay = imageTaskRetryDelayMs(response.headers.get('retry-after'), retryDelay);
    }

    throw new Error('图片生成超时：等待 16 分钟后仍未完成');
}

async function tryGenerateWithOpenAI(prompt, targetDir, options = {}) {
    try {
        const providerConfig = options.providerConfig || {};
        const apiKey = String(providerConfig.apiKey || process.env.OPENAI_API_KEY || '').trim();
        if (!apiKey) {
            return { success: false, error: 'OpenAI image API key is missing' };
        }

        const sourceImages = collectImageEditInputs(options.sourceReferences || []);
        const isEdit = sourceImages.length > 0;
        const model = process.env.FLOW_CANVAS_IMAGE_MODEL || providerConfig.model || options.model || 'gpt-image-2';
        const size = String(options.size || '').trim().replace(/\u00d7/g, 'x');
        const requestedQuality = String(options.quality || 'high').trim().toLowerCase();
        const quality = ['auto', 'low', 'medium', 'high'].includes(requestedQuality) ? requestedQuality : 'high';
        const midjourneyModel = isMidjourneyImageModel(model);
        const nativeMidjourney = shouldUseNativeMidjourneyRoute(model, providerConfig.endpoint);
        const openAiImageEdit = isEdit && !midjourneyModel;
        let midjourneyImageUrls = [];
        if (midjourneyModel && isEdit && !nativeMidjourney) {
            const dataUris = sourceImages.map(image =>
                `data:${image.mimeType || 'application/octet-stream'};base64,${image.buffer.toString('base64')}`
            );
            midjourneyImageUrls = await uploadTemporaryReferences(
                dataUris,
                'Midjourney 参考图',
                temporaryUploadProviders(options),
                options.onProgress,
                'Midjourney 任务'
            );
        }
        const midjourneyOptions = midjourneyModel
            ? { ...(options.midjourney || {}), hasImagePrompt: sourceImages.length > 0 }
            : options.midjourney;
        const endpoint = nativeMidjourney
            ? buildMidjourneySubmitEndpoint(providerConfig.endpoint)
            : buildOpenAiImageEndpoint(providerConfig.endpoint, openAiImageEdit ? 'edits' : 'generations');
        const buildRequest = (compatibilityMode = false) => {
            let requestPrompt = compatibilityMode
                ? buildMidjourneyCompatibilityPrompt(prompt, midjourneyOptions, size)
                : (midjourneyModel ? appendMidjourneyParameters(prompt, midjourneyOptions, size) : prompt);
            if (midjourneyImageUrls.length) {
                requestPrompt = prependMidjourneyImagePrompts(requestPrompt, midjourneyImageUrls);
            }
            const requestBody = nativeMidjourney
                ? buildMidjourneyImaginePayload(
                    requestPrompt,
                    sourceImages,
                    '',
                    compatibilityMode ? {} : midjourneyOptions
                )
                : (compatibilityMode
                    ? {
                        model,
                        prompt: requestPrompt,
                        n: 1,
                        response_format: options.responseFormat === 'b64_json' ? 'b64_json' : 'url'
                    }
                    : buildOpenAiImageRequestBody({
                        model,
                        prompt: requestPrompt,
                        n: options.n,
                        size,
                        responseFormat: options.responseFormat,
                        options: { ...options, quality }
                    }));

            if (openAiImageEdit) {
                // The relay documents stream for multipart edits, but not history_disabled.
                const multipartFields = { ...requestBody };
                delete multipartFields.history_disabled;
                const multipart = buildImageEditMultipart(multipartFields, sourceImages);
                return { requestBody, requestPayload: multipart.body, contentType: multipart.contentType };
            }
            return {
                requestBody,
                requestPayload: JSON.stringify(requestBody),
                contentType: 'application/json'
            };
        };

        let { requestBody, requestPayload, contentType } = buildRequest(false);

        const requestId = options.requestId || crypto.randomUUID?.() || crypto.randomBytes(16).toString('hex');
        let res;
        let responseText = '';
        let responseErrorText = '';
        let requestAttempt = 0;
        let compatibilityFallbackUsed = false;
        const retryDelays = options.noSubmissionRetry === true ? [] : [2000, 5000];
        for (; requestAttempt <= retryDelays.length; requestAttempt += 1) {
            throwIfGenerationCanceled(options.signal);
            const requestAbort = createLinkedAbortController(options.signal, 300000);
            const activeRequestId = compatibilityFallbackUsed ? `${requestId}-mj-compat` : requestId;
            const startedAt = Date.now();
            let phase = '等待响应';
            const diagnostic = {
                requestId: activeRequestId, startedAt,
                clientTaskId: options.clientTaskId, projectId: options.projectId, nodeId: options.nodeId,
                payloadBytes: Buffer.byteLength(requestPayload), imageCount: sourceImages.length,
                referenceManifest: sourceImages.map((image, index) => ({
                    uploadIndex: index + 1, bytes: image.buffer.length, mimeType: image.mimeType,
                    sha256: crypto.createHash('sha256').update(image.buffer).digest('hex'),
                    multipartField: openAiImageEdit ? (sourceImages.length === 1 ? 'image' : 'image[]') : null
                }))
            };
            options.onRequestDiagnostic?.({ ...diagnostic, phase });
            recordDiagnostic('info', 'image.request', { ...diagnostic, endpoint, model });
            try {
                res = await net.fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': contentType,
                        Accept: requestBody.stream === true
                            ? 'text/event-stream, application/json'
                            : 'application/json',
                        'Idempotency-Key': activeRequestId,
                        'X-Log-Id': activeRequestId
                    },
                    body: requestPayload,
                    signal: requestAbort.controller.signal,
                    redirect: 'follow'
                });
                phase = '读取结果';
                recordDiagnostic('info', 'image.responseHeaders', { requestId: activeRequestId,
                    status: res.status, elapsedMs: Date.now() - startedAt,
                    serverRequestId: res.headers.get('x-request-id') || res.headers.get('x-log-id') || res.headers.get('request-id'),
                    contentType: res.headers.get('content-type') });
                const location = res.headers.get('location');
                const earlyTaskId = location && getImageTaskId({}, res.status, location);
                if (res.ok && earlyTaskId) options.onTaskSubmitted?.({ taskId: earlyTaskId, model, status: 'queued', location });
                responseText = await res.text();
                recordDiagnostic('info', 'image.responseBody', { requestId: activeRequestId,
                    elapsedMs: Date.now() - startedAt, responseBytes: Buffer.byteLength(responseText) });
            } catch (error) {
                throwIfGenerationCanceled(options.signal);
                const attempts = requestAttempt + 1;
                const timedOut = requestAbort.controller.signal.aborted;
                recordDiagnostic('error', 'image.requestFailed', { ...diagnostic, phase, timedOut,
                    elapsedMs: Date.now() - startedAt, error });
                // A dropped POST response does not prove the server rejected the paid task.
                if (phase === '读取结果' || timedOut || /ERR_EMPTY_RESPONSE/i.test(error?.message || '')) {
                    options.onRequestDiagnostic?.({ ...diagnostic, phase, state: 'submission_unknown' });
                    throw remoteConnectionError('提交图片生成请求', endpoint,
                        imageRequestFailure(error, { ...diagnostic, phase, timedOut }), attempts);
                }
                if (!isRetryableImageNetworkError(error) || requestAttempt >= retryDelays.length) {
                    throw remoteConnectionError('提交图片生成请求', endpoint,
                        imageRequestFailure(error, { ...diagnostic, phase, timedOut }), attempts);
                }
                const retryDelay = retryDelays[requestAttempt];
                console.warn(`[FlowCanvasBridge] Image API connection failed; retrying in ${retryDelay}ms (${attempts}/${retryDelays.length}): ${error.message}`);
                await sleep(retryDelay, options.signal);
                continue;
            } finally {
                requestAbort.cleanup();
            }
            if (res.ok) break;

            responseErrorText = responseText;
            if (
                midjourneyModel
                && options.noSubmissionRetry !== true
                && !compatibilityFallbackUsed
                && isAllVendorsFailedImageResponse(res.status, responseErrorText)
            ) {
                ({ requestBody, requestPayload, contentType } = buildRequest(true));
                compatibilityFallbackUsed = true;
                requestAttempt = retryDelays.length - 1;
                console.warn('[FlowCanvasBridge] Midjourney full request was rejected by all upstream vendors; retrying once with compatibility parameters.');
                continue;
            }
            if (!isRetryableImageHttpStatus(res.status) || requestAttempt >= retryDelays.length) break;
            const retryDelay = imageTaskRetryDelayMs(
                res.headers.get('retry-after'),
                retryDelays[requestAttempt]
            );
            console.warn(`[FlowCanvasBridge] Image API returned HTTP ${res.status}; retrying in ${retryDelay}ms (${requestAttempt + 1}/${retryDelays.length})`);
            await sleep(retryDelay, options.signal);
        }
        if (!res.ok) {
            const text = responseErrorText || responseText;
            if (res.status === 413) {
                return {
                    success: false,
                    error: '参考图片总大小超过 API 网关限制（HTTP 413）。请使用“批量转小”后重试。'
                };
            }
            return {
                success: false,
                error: imageHttpErrorMessage(res.status, text, {
                    nativeMidjourney,
                    midjourneyModel,
                    attempts: requestAttempt + 1,
                    compatibilityFallbackUsed
                })
            };
        }
        const location = res.headers.get('location');
        const json = parseImageApiResponseText(responseText, res.headers.get('content-type'))
            || (location ? { status: 'queued' } : null);
        if (!json) return { success: false, error: 'Image API did not return valid JSON' };
        let finalPayload = json;
        let image = getGeneratedImageData(finalPayload);
        let taskId = '';
        if (isImageTaskPayload(json, res.status, location)) {
            taskId = getImageTaskId(json, res.status, location);
            options.onTaskSubmitted?.({
                taskId,
                model,
                location,
                status: imageTaskStatus(json) || 'queued'
            });
            if (!image) {
                const completed = await pollOpenAiImageTask(endpoint, apiKey, taskId, json, {
                    location,
                    retryAfter: res.headers.get('retry-after'),
                    model,
                    nativeMidjourney,
                    signal: options.signal
                });
                image = completed.image;
                finalPayload = completed.payload;
            }
        } else if (res.status === 202) {
            const reason = imageTaskErrorMessage(json);
            return {
                success: false,
                error: reason
                    ? `图片中转接受了任务，但丢失了任务 ID：${reason}`
                    : '图片中转接受了任务，但没有返回任务 ID；请检查 NewAPI 是否正确转发异步响应的 Location 和响应体。'
            };
        } else if (nativeMidjourney) {
            return {
                success: false,
                error: `Midjourney 提交失败：${imageTaskErrorMessage(json) || `code ${String(json?.code ?? 'unknown')}`}`
            };
        }
        const imageEntries = getGeneratedImageDataList(finalPayload);
        if (!imageEntries.length && image) imageEntries.push(image);
        const savedImages = (await Promise.all(imageEntries.map(entry =>
            saveGeneratedImage(entry, endpoint, targetDir, prompt, apiKey, options.signal)
        ))).filter(Boolean);
        if (!savedImages.length) return { success: false, error: 'OpenAI response did not include image data' };

        let outputImages = savedImages;
        let gridFilePath = null;
        if (isMidjourneyImagineModel(model) && savedImages.length === 1 && savedImages[0].mediaType === 'image') {
            const candidates = await splitMidjourneyGrid(savedImages[0]);
            if (candidates.length === 4) {
                gridFilePath = savedImages[0].filePath;
                outputImages = candidates;
            }
        }

        const primary = outputImages[0];
        const filePath = primary.filePath;
        const actualSize = primary.width && primary.height ? `${primary.width}x${primary.height}` : null;
        const buttons = finalPayload?.buttons || finalPayload?.result?.buttons || [];
        options.onDownloaded?.({ filePath, filePaths: outputImages.map(entry => entry.filePath),
            images: outputImages, mediaType: primary.mediaType || 'image', taskId: taskId || null, targetDir });
        return {
            success: true,
            provider: 'openai',
            filePath,
            filePaths: outputImages.map(entry => entry.filePath),
            images: outputImages,
            width: primary.width || 1024,
            height: primary.height || 1024,
            requestedSize: size || null,
            actualSize,
            mediaType: primary.mediaType || 'image',
            sizeMatchesRequest: !size || !actualSize || actualSize.toLowerCase() === size.toLowerCase(),
            endpointMode: nativeMidjourney
                ? 'midjourney-imagine'
                : (midjourneyImageUrls.length ? 'midjourney-image-prompt' : (openAiImageEdit ? 'edits' : 'generations')),
            taskId: taskId || null,
            midjourney: midjourneyModel ? {
                candidateCount: outputImages.length,
                gridFilePath,
                compatibilityFallbackUsed,
                imagePromptCount: midjourneyImageUrls.length,
                buttons: Array.isArray(buttons) ? buttons : []
            } : null
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function buildOpenAiVideoTaskEndpoint(generationEndpoint, taskId) {
    const url = new URL(generationEndpoint);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encodeURIComponent(taskId)}`;
    url.search = '';
    url.hash = '';
    return url.toString();
}

function buildOpenAiTaskEndpoint(generationEndpoint, taskId) {
    const url = new URL(generationEndpoint);
    const basePath = url.pathname.replace(/\/video\/generations\/?$/i, '/tasks').replace(/\/+$/, '');
    url.pathname = `${basePath}/${encodeURIComponent(taskId)}`;
    url.search = '';
    url.hash = '';
    return url.toString();
}

function describeRemoteEndpoint(value) {
    try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
    } catch (_) {
        return '\u5df2\u914d\u7f6e\u7684\u89c6\u9891\u63a5\u53e3';
    }
}

function describeRemoteFailure(error) {
    const detail = error?.message || String(error);
    const knownErrors = [
        [/ERR_CONNECTION_CLOSED/i, '\u670d\u52a1\u5668\u63d0\u524d\u5173\u95ed\u4e86\u8fde\u63a5'],
        [/ERR_CONNECTION_RESET/i, '\u8fde\u63a5\u88ab\u670d\u52a1\u5668\u91cd\u7f6e'],
        [/ERR_TIMED_OUT|timeout/i, '\u8fde\u63a5\u8d85\u65f6'],
        [/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i, '\u65e0\u6cd5\u89e3\u6790\u670d\u52a1\u5668\u57df\u540d'],
        [/ERR_INTERNET_DISCONNECTED/i, '\u5f53\u524d\u7f51\u7edc\u5df2\u65ad\u5f00'],
        [/ERR_CERT_/i, '\u670d\u52a1\u5668\u8bc1\u4e66\u6821\u9a8c\u5931\u8d25'],
        [/fetch failed/i, '\u7f51\u7edc\u8bf7\u6c42\u5931\u8d25']
    ];
    const match = knownErrors.find(([pattern]) => pattern.test(detail));
    return match ? `${match[1]}\uff08${detail}\uff09` : detail;
}

function remoteConnectionError(stage, endpoint, error, attempts = 1) {
    const detail = describeRemoteFailure(error);
    const retryText = attempts > 1 ? `\uff0c\u5df2\u91cd\u8bd5 ${attempts - 1} \u6b21` : '';
    return new Error(`${stage}\u8fde\u63a5\u5931\u8d25\uff08${describeRemoteEndpoint(endpoint)}${retryText}\uff09\uff1a${detail}`);
}

async function fetchTextWithRetry(url, options, stage, attempts = 3) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        throwIfGenerationCanceled(options?.signal);
        const linked = createLinkedAbortController(options?.signal, 45000);
        try {
            const response = await net.fetch(url, { ...options, signal: linked.controller.signal });
            const text = await response.text();
            return { response, text };
        } catch (error) {
            throwIfGenerationCanceled(options?.signal);
            lastError = error;
            if (attempt < attempts - 1) await sleep(750 * (attempt + 1), options?.signal);
        } finally { linked.cleanup(); }
    }
    throw remoteConnectionError(stage, url, lastError, attempts);
}

async function compressVideoReferenceImage(filePath, targetBytes) {
    const metadata = await sharp(filePath).metadata();
    const outputFormat = metadata.hasAlpha ? 'webp' : 'jpeg';
    const attempts = [
        { maxEdge: null, quality: 90 },
        { maxEdge: 3072, quality: 86 },
        { maxEdge: 2048, quality: 82 },
        { maxEdge: 1536, quality: 78 },
        { maxEdge: 1280, quality: 74 },
        { maxEdge: 1024, quality: 70 },
        { maxEdge: 768, quality: 66 },
        { maxEdge: 640, quality: 62 },
        { maxEdge: 512, quality: 58 }
    ];
    let best = null;

    for (const attempt of attempts) {
        let pipeline = sharp(filePath).rotate();
        if (attempt.maxEdge) {
            pipeline = pipeline.resize({
                width: attempt.maxEdge,
                height: attempt.maxEdge,
                fit: 'inside',
                withoutEnlargement: true
            });
        }
        const buffer = outputFormat === 'webp'
            ? await pipeline.webp({ quality: attempt.quality }).toBuffer()
            : await pipeline.jpeg({ quality: attempt.quality, mozjpeg: true }).toBuffer();
        if (!best || buffer.length < best.length) best = buffer;
        if (buffer.length <= targetBytes) break;
    }

    return {
        buffer: best,
        mimeType: outputFormat === 'webp' ? 'image/webp' : 'image/jpeg'
    };
}

async function collectVideoReferenceImages(sourceReferences = [], compressLargeImages = false, maxItems = 9) {
    const references = sourceReferences.slice(0, maxItems);
    const targetBytes = Math.max(
        768 * 1024,
        Math.min(VIDEO_REFERENCE_MAX_OUTPUT_BYTES, Math.floor(VIDEO_REFERENCE_UPLOAD_BUDGET_BYTES / Math.max(1, references.length)))
    );
    return Promise.all(references.map(async (reference, index) => {
        const filePath = String(reference?.filePath || '');
        const extension = path.extname(filePath).toLowerCase();
        let mimeType = extension === '.png'
            ? 'image/png'
            : extension === '.webp'
                ? 'image/webp'
                : 'image/jpeg';
        let buffer = await fs.promises.readFile(filePath);
        if (compressLargeImages && buffer.length > targetBytes) {
            const originalBytes = buffer.length;
            const compressed = await compressVideoReferenceImage(filePath, targetBytes);
            buffer = compressed.buffer;
            mimeType = compressed.mimeType;
            console.info('[FlowCanvasBridge] Compressed video reference image:', {
                fileName: path.basename(filePath),
                originalBytes,
                compressedBytes: buffer.length
            });
        }
        const role = references.length === 1
            ? 'first_frame'
            : references.length === 2
                ? (index === 0 ? 'first_frame' : 'last_frame')
                : 'reference_image';
        return {
            url: `data:${mimeType};base64,${buffer.toString('base64')}`,
            role
        };
    }));
}

function collectVideoReferenceVideos(videoReferences = [], maxBytes = 128 * 1024 * 1024) {
    return videoReferences.slice(0, 3).map(reference => {
        const filePath = String(reference?.filePath || '');
        const size = fs.statSync(filePath).size;
        if (size > maxBytes) {
            throw new Error(`视频参考素材超过 ${Math.round(maxBytes / (1024 * 1024))} MB 限制：${path.basename(filePath)}`);
        }
        const extension = path.extname(filePath).toLowerCase();
        const mimeType = extension === '.webm'
            ? 'video/webm'
            : extension === '.mov'
                ? 'video/quicktime'
                : 'video/mp4';
        return `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`;
    });
}

function collectVideoReferenceAudio(audioReferences = [], maxItems = 3, maxBytes = 32 * 1024 * 1024) {
    return audioReferences.slice(0, maxItems).map(reference => {
        const filePath = String(reference?.filePath || '');
        const size = fs.statSync(filePath).size;
        if (size > maxBytes) {
            throw new Error(`音频参考素材超过 ${Math.round(maxBytes / (1024 * 1024))} MB 限制：${path.basename(filePath)}`);
        }
        const extension = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.aac': 'audio/aac',
            '.flac': 'audio/flac',
            '.ogg': 'audio/ogg'
        };
        const mimeType = mimeTypes[extension] || 'application/octet-stream';
        return `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`;
    });
}

function decodeReferenceDataUri(dataUri) {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(String(dataUri || '').trim());
    if (!match) throw new Error('参考素材不是有效的 Base64 数据');
    return {
        mimeType: match[1].toLowerCase(),
        buffer: Buffer.from(match[2], 'base64')
    };
}

function extensionForReferenceMimeType(mimeType) {
    const extensions = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'video/mp4': 'mp4',
        'video/webm': 'webm',
        'video/quicktime': 'mov',
        'audio/mpeg': 'mp3',
        'audio/wav': 'wav',
        'audio/aac': 'aac',
        'audio/flac': 'flac',
        'audio/ogg': 'ogg'
    };
    return extensions[mimeType] || 'bin';
}

function multipartField(boundary, name, value) {
    return Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8'
    );
}

function buildTemporaryUploadBody(provider, boundary, fileName, mimeType, buffer) {
    const fields = provider.fields.map(([name, value]) => multipartField(boundary, name, value));
    return Buffer.concat([
        ...fields,
        Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${provider.fileField}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
            'utf8'
        ),
        buffer,
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ]);
}

function parseTemporaryUploadUrl(provider, responseText) {
    const text = String(responseText || '').trim();
    if (provider.responseType === 'json') {
        try {
            const payload = JSON.parse(text);
            const url = payload?.url || payload?.files?.[0]?.url;
            return payload?.success === true && /^https?:\/\/\S+$/i.test(String(url || ''))
                ? String(url)
                : '';
        } catch (_) {
            return '';
        }
    }
    return /^https?:\/\/\S+$/i.test(text) ? text : '';
}

function loadPrivateTemporaryUploadConfig(overrides = {}) {
    let saved = {};
    try {
        const configPath = path.join(app.getPath('userData'), 'upload-storage.json');
        if (fs.existsSync(configPath)) {
            saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (error) {
        console.warn('[FlowCanvasBridge] Failed to read private upload storage config:', error.message);
    }

    const endpoint = String(
        overrides.temporaryUploadEndpoint
        || process.env.FLOW_CANVAS_UPLOAD_ENDPOINT
        || saved.endpoint
        || ''
    ).trim();
    const token = String(
        overrides.temporaryUploadToken
        || process.env.FLOW_CANVAS_UPLOAD_TOKEN
        || saved.token
        || ''
    ).trim();
    if (!endpoint || !token) return null;

    try {
        const url = new URL(endpoint);
        if (url.protocol !== 'https:') throw new Error('endpoint must use HTTPS');
        return {
            endpoint: url.toString(),
            token
        };
    } catch (error) {
        console.warn('[FlowCanvasBridge] Ignoring invalid private upload storage endpoint:', error.message);
        return null;
    }
}

function temporaryUploadProviders(overrides = {}) {
    const privateConfig = loadPrivateTemporaryUploadConfig(overrides);
    const selfHosted = privateConfig
        ? [{
            id: 'flow-canvas-storage',
            name: 'Flow Canvas 自建存储',
            endpoint: privateConfig.endpoint,
            fields: [],
            fileField: 'file',
            accept: 'application/json',
            responseType: 'json',
            headers: {
                Authorization: `Bearer ${privateConfig.token}`
            }
        }]
        : [];
    return [...selfHosted, ...FALLBACK_TEMP_REFERENCE_UPLOAD_PROVIDERS];
}

function temporaryUploadProviderFingerprint(providers) {
    return crypto.createHash('sha256')
        .update(providers.map(provider => `${provider.id}:${provider.endpoint}`).join('|'))
        .digest('hex')
        .slice(0, 16);
}

function temporaryUploadTimeoutMs(bufferLength) {
    const extraSeconds = Math.ceil(bufferLength / (1024 * 1024)) * 5;
    return Math.min(75_000, 30_000 + extraSeconds * 1000);
}

async function uploadTemporaryReferenceBuffer({
    buffer,
    mimeType,
    contentHash,
    cacheKey,
    label,
    providers,
    failureSubject = '视频任务'
}) {
    const extension = extensionForReferenceMimeType(mimeType);
    const fileName = `flow-canvas-${contentHash.slice(0, 16)}.${extension}`;
    const failures = [];
    let totalAttempts = 0;

    for (const provider of providers) {
        for (let attempt = 1; attempt <= TEMP_REFERENCE_UPLOAD_ATTEMPTS_PER_PROVIDER; attempt += 1) {
            totalAttempts += 1;
            const boundary = `----FlowCanvas${crypto.randomBytes(12).toString('hex')}`;
            const body = buildTemporaryUploadBody(provider, boundary, fileName, mimeType, buffer);
            const controller = new AbortController();
            const timeoutMs = temporaryUploadTimeoutMs(buffer.length);
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            let response;
            let responseText = '';
            let retryable = true;
            let failure = '未知错误';
            try {
                response = await net.fetch(provider.endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': `multipart/form-data; boundary=${boundary}`,
                        Accept: provider.accept,
                        ...(provider.headers || {})
                    },
                    body,
                    signal: controller.signal,
                    redirect: 'follow'
                });
                responseText = (await response.text()).trim();
                const uploadedUrl = response.ok
                    ? parseTemporaryUploadUrl(provider, responseText)
                    : '';
                if (uploadedUrl) {
                    const cacheEntry = {
                        url: uploadedUrl,
                        expiresAt: Date.now() + TEMP_REFERENCE_CACHE_TTL_MS,
                        referenceId: `ref_${contentHash.slice(0, 24)}`,
                        providerId: provider.id
                    };
                    temporaryReferenceUrlCache.set(cacheKey, cacheEntry);
                    await getReferenceCache().setUpload(cacheKey, cacheEntry).catch(error => {
                        console.warn('[FlowCanvasBridge] Failed to persist temporary upload cache:', error.message);
                    });
                    return uploadedUrl;
                }
                failure = `HTTP ${response.status} ${responseText.slice(0, 300)}`.trim();
                retryable = [408, 425, 429].includes(response.status) || response.status >= 500 || response.ok;
            } catch (error) {
                failure = error?.name === 'AbortError'
                    ? `上传超时（${Math.round(timeoutMs / 1000)} 秒）`
                    : (error.message || String(error));
            } finally {
                clearTimeout(timeout);
            }

            failures.push(`${provider.name}: ${failure}`);
            if (!retryable || attempt === TEMP_REFERENCE_UPLOAD_ATTEMPTS_PER_PROVIDER) break;
            const retryAfterSeconds = Number(response?.headers?.get('retry-after'));
            const delay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
                ? Math.min(10_000, retryAfterSeconds * 1000)
                : 800 * attempt;
            console.warn(`[FlowCanvasBridge] ${label} upload to ${provider.name} failed; retrying ${attempt + 1}/${TEMP_REFERENCE_UPLOAD_ATTEMPTS_PER_PROVIDER}:`, failure);
            await sleep(delay);
        }
    }

    const providerNames = providers.map(provider => provider.name).join('、');
    throw new Error(
        `${label}临时上传失败（${providerNames} 共尝试 ${totalAttempts} 次）：${failures.slice(-3).join('；')}`
        + `。${failureSubject}尚未提交到模型服务，不会产生本次生成费用。`
    );
}

async function uploadTemporaryReference(dataUri, label, providers, failureSubject = '视频任务') {
    if (/^https?:\/\//i.test(String(dataUri || '').trim())) return String(dataUri).trim();

    const { mimeType, buffer } = decodeReferenceDataUri(dataUri);
    if (buffer.length === 0) throw new Error(`${label}内容为空`);
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const cacheKey = `${temporaryUploadProviderFingerprint(providers)}:${contentHash}`;
    const cached = temporaryReferenceUrlCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    const persisted = await getReferenceCache().getUpload(cacheKey);
    if (persisted) {
        temporaryReferenceUrlCache.set(cacheKey, persisted);
        return persisted.url;
    }

    const pending = temporaryReferenceUploadTasks.get(cacheKey);
    if (pending) return pending;
    const task = uploadTemporaryReferenceBuffer({
        buffer,
        mimeType,
        contentHash,
        cacheKey,
        label,
        providers,
        failureSubject
    });
    temporaryReferenceUploadTasks.set(cacheKey, task);
    try {
        return await task;
    } finally {
        temporaryReferenceUploadTasks.delete(cacheKey);
    }
}

async function uploadTemporaryReferences(
    entries,
    labelPrefix,
    providers,
    onProgress,
    failureSubject = '视频任务'
) {
    const urls = new Array(entries.length);
    let nextIndex = 0;
    const workerCount = Math.min(TEMP_REFERENCE_UPLOAD_CONCURRENCY, entries.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (nextIndex < entries.length) {
            const index = nextIndex;
            nextIndex += 1;
            onProgress?.({
                stage: 'upload',
                mediaType: labelPrefix,
                current: index + 1,
                total: entries.length
            });
            urls[index] = await uploadTemporaryReference(
                entries[index],
                `${labelPrefix} ${index + 1}`,
                providers,
                failureSubject
            );
        }
    });
    await Promise.all(workers);
    return urls;
}

async function uploadVideoReferencesOrUseOriginals(
    entries,
    labelPrefix,
    providers,
    onProgress,
    failureSubject = '视频任务'
) {
    if (entries.length === 0) return [];
    try {
        return await uploadTemporaryReferences(
            entries,
            labelPrefix,
            providers,
            onProgress,
            failureSubject
        );
    } catch (error) {
        // Keep the provider's native Base64 path available when temporary hosts are unavailable.
        console.warn(
            `[FlowCanvasBridge] ${labelPrefix}临时上传失败，改为直接提交原始素材：`,
            error?.message || String(error)
        );
        return entries;
    }
}

function createVideoRecoveryId() {
    return `fc_${crypto.randomUUID().replace(/-/g, '')}`;
}

function summarizeVideoRequest(endpoint, body = {}, logId = '') {
    const mediaCounts = {};
    for (const key of [
        'images', 'reference_images', 'reference_videos', 'reference_audios',
        'videos', 'audio_urls'
    ]) {
        if (Array.isArray(body[key]) && body[key].length > 0) mediaCounts[key] = body[key].length;
    }
    for (const key of ['first_image', 'last_image', 'reference_video', 'reference_audio']) {
        if (body[key]) mediaCounts[key] = 1;
    }
    const scalarKeys = [
        'model', 'resolution', 'size', 'ratio', 'aspect_ratio', 'duration', 'seconds',
        'workflow_id', 'camera_fixed', 'generate_audio', 'web_search', 'watermark'
    ];
    const parameters = {};
    for (const key of scalarKeys) {
        if (body[key] !== undefined && body[key] !== null && body[key] !== '') parameters[key] = body[key];
    }
    return {
        endpoint: describeRemoteEndpoint(endpoint),
        logId: String(logId || '') || undefined,
        parameters,
        promptLength: String(body.prompt || '').length,
        mediaCounts
    };
}

function isAmbiguousVideoSubmitError(error) {
    return /ERR_CONNECTION_(?:CLOSED|RESET)|ERR_TIMED_OUT|socket hang up|other side closed|fetch failed/i
        .test(error?.message || String(error));
}

function isCompletedVideoStatus(status) {
    return ['succeeded', 'completed', 'success'].includes(String(status || '').toLowerCase());
}

function isFailedVideoStatus(status) {
    return ['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(String(status || '').toLowerCase());
}

function videoTaskProgressPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    return Math.min(100, Math.round(numeric <= 1 ? numeric * 100 : numeric));
}

function videoTaskProgressStage(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (['queued', 'pending', 'submitted', 'waiting'].includes(normalized)) return 'queued';
    return 'processing';
}

function sleep(ms, signal = null) {
    if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
    throwIfGenerationCanceled(signal);
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
        }, ms);
        const abort = () => {
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
            reject(generationCanceledError());
        };
        signal.addEventListener('abort', abort, { once: true });
    });
}

async function pollOpenAiVideoTask(generationEndpoint, apiKey, taskId, initialResponse, options = {}) {
    const directUrl = getVideoResultUrl(initialResponse);
    if (directUrl) {
        options.onProgress?.({ stage: 'download' });
        return { payload: initialResponse, url: directUrl, taskId };
    }
    if (!taskId) throw new Error('\u89c6\u9891\u63a5\u53e3\u8fd4\u56de\u4e2d\u6ca1\u6709\u4efb\u52a1 ID \u6216\u89c6\u9891\u5730\u5740');

    let currentTaskId = String(taskId);
    const buildTaskUrls = value => {
        const addModelQuery = endpoint => {
            if (!options.model
                || isMiniMaxH3NativeEndpoint(generationEndpoint)
                || isMiniMaxH3PerSecondEndpoint(generationEndpoint)) return endpoint;
            const url = new URL(endpoint);
            url.searchParams.set('model', options.model);
            return url.toString();
        };
        const genericTaskEndpoint = addModelQuery(buildOpenAiTaskEndpoint(generationEndpoint, value));
        const videoTaskEndpoint = addModelQuery(buildOpenAiVideoTaskEndpoint(generationEndpoint, value));
        const candidates = options.preferVideoTaskEndpoint
            ? [videoTaskEndpoint, genericTaskEndpoint]
            : [genericTaskEndpoint, videoTaskEndpoint];
        return candidates
            .filter(Boolean)
            .filter((candidate, index, values) => values.indexOf(candidate) === index);
    };
    let taskUrls = buildTaskUrls(currentTaskId);
    let taskUrlIndex = 0;
    let recoveryNotFoundCount = 0;
    let consecutiveConnectionFailures = 0;
    let transientFailures = 0;
    let emptyCompleted = 0;
    const wait = options.wait || sleep;
    const fetchTask = options.fetchTask || fetchTextWithRetry;
    const isRecoveringSubmission = initialResponse?.recovering === true;
    options.onProgress?.({ stage: isRecoveringSubmission ? 'recovering' : 'queued' });
    for (let attempt = 0; attempt < 720; attempt += 1) {
        if (attempt > 0) await wait(Math.min(30000, 5000 * Math.max(1, transientFailures)), options.signal);
        throwIfGenerationCanceled(options.signal);
        let taskUrl = taskUrls[taskUrlIndex];
        let response;
        let text;
        try {
            ({ response, text } = await fetchTask(taskUrl, {
                method: 'GET',
                headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
                redirect: 'follow',
                signal: options.signal
            }, '\u67e5\u8be2\u89c6\u9891\u4efb\u52a1\u72b6\u6001'));
            if ([404, 405].includes(response.status)
                || (isMiniMaxH3Model(options.model) && response.status === 400)) {
                if (taskUrlIndex >= taskUrls.length - 1) {
                    // Keep the final response so the normal error path reports its body.
                } else {
                    taskUrlIndex += 1;
                    taskUrl = taskUrls[taskUrlIndex];
                    ({ response, text } = await fetchTask(taskUrl, {
                        method: 'GET',
                        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
                        redirect: 'follow',
                        signal: options.signal
                    }, '\u67e5\u8be2\u89c6\u9891\u4efb\u52a1\u72b6\u6001'));
                }
            }
            consecutiveConnectionFailures = 0;
        } catch (error) {
            throwIfGenerationCanceled(options.signal);
            consecutiveConnectionFailures += 1;
            if (consecutiveConnectionFailures < 24) {
                options.onProgress?.({ stage: 'recovering', retryCount: consecutiveConnectionFailures, lastError: error.message });
                console.warn('[FlowCanvasBridge] Video status connection interrupted; polling will continue:', error.message);
                continue;
            }
            throw error;
        }
        if ([400, 404].includes(response.status) && isRecoveringSubmission && recoveryNotFoundCount < 24) {
            recoveryNotFoundCount += 1;
            taskUrlIndex = 0;
            continue;
        }
        if ([408, 425, 429, 500, 502, 503, 504].includes(response.status) && ++transientFailures <= 24) {
            options.onProgress?.({ stage: 'recovering', retryCount: transientFailures, lastError: `HTTP ${response.status}` });
            continue;
        }
        if (!response.ok) {
            throw new Error(`\u67e5\u8be2\u89c6\u9891\u4efb\u52a1\u5931\u8d25\uff08${describeRemoteEndpoint(taskUrl)}\uff09\uff1a${response.status} ${text.slice(0, 1000)}`);
        }
        recoveryNotFoundCount = 0;
        let payload;
        try {
            payload = JSON.parse(text);
        } catch (_) {
            if (++transientFailures <= 24) continue;
            throw new Error(`查询视频任务 ${currentTaskId} 时，服务器持续返回无效 JSON；可稍后再次拉取`);
        }
        transientFailures = 0;
        const payloadError = getVideoPayloadError(payload);
        if (payloadError && !getVideoResultUrl(payload)) {
            throw new Error(formatVideoTaskFailure(payloadError, describeRemoteEndpoint(taskUrl), '查询视频任务失败'));
        }
        const resolvedTaskId = getVideoTaskId(payload);
        if (resolvedTaskId && resolvedTaskId !== currentTaskId) {
            currentTaskId = resolvedTaskId;
            taskUrls = buildTaskUrls(currentTaskId);
            taskUrlIndex = 0;
            options.onTaskIdResolved?.(currentTaskId, payload);
        }
        const url = getVideoResultUrl(payload);
        const taskStatus = getVideoTaskStatus(payload);
        if (url && (isCompletedVideoStatus(taskStatus) || !taskStatus)) {
            options.onProgress?.({ stage: 'download', progress: 100 });
            return { payload, url, taskId: currentTaskId };
        }
        if (isFailedVideoStatus(taskStatus)) {
            const reason = getVideoPayloadError(payload) || '\u670d\u52a1\u7aef\u672a\u63d0\u4f9b\u5931\u8d25\u539f\u56e0';
            throw new Error(formatVideoTaskFailure(reason));
        }
        if (isCompletedVideoStatus(taskStatus) && !url && ++emptyCompleted > 12) {
            throw new Error(`视频任务 ${currentTaskId} 已完成，但上游尚未返回产物地址；可稍后再次拉取`);
        }
        options.onProgress?.({
            stage: videoTaskProgressStage(taskStatus),
            progress: videoTaskProgressPercent(getVideoTaskProgress(payload)),
            remoteStatus: taskStatus || null
        });
    }
    throw new Error('\u89c6\u9891\u751f\u6210\u8d85\u65f6\uff1a\u7b49\u5f85 60 \u5206\u949f\u540e\u4ecd\u672a\u5b8c\u6210');
}

function isVideoPromptModerationFailure(reason) {
    return /提示词.*(?:审核|未通过|违规)|(?:审核|审核不通过|内容安全).*(?:提示词|prompt)|prompt.*(?:moderation|review|violation|safety)/i.test(String(reason || ''));
}

function formatVideoTaskFailure(reason, endpoint = '', stage = '视频生成任务失败') {
    const detail = String(reason || '服务端未提供失败原因');
    const endpointText = endpoint ? `（${endpoint}）` : '';
    if (isVideoPromptModerationFailure(detail)) {
        return `${stage}${endpointText}：提示词审核失败，${detail}。任务 ID 已保留，可继续恢复查询；修改提示词后可重新生成。`;
    }
    return `${stage}${endpointText}：${detail}`;
}

function videoExtensionFromUrl(url, contentType = '') {
    const fromType = String(contentType).toLowerCase();
    if (fromType.includes('webm')) return '.webm';
    if (fromType.includes('quicktime')) return '.mov';
    try {
        const extension = path.extname(new URL(url).pathname).toLowerCase();
        if (VIDEO_EXTENSIONS.has(extension)) return extension;
    } catch (_) {
        // Use the standard mp4 fallback when an upstream URL cannot be parsed.
    }
    return '.mp4';
}

function uniqueVideoName(prefix, prompt, ext = '.mp4') {
    const hash = crypto.createHash('sha1').update(`${Date.now()}:${prompt}:${Math.random()}`).digest('hex').slice(0, 12);
    return `${prefix}_${hash}${VIDEO_EXTENSIONS.has(ext) ? ext : '.mp4'}`;
}

async function downloadVideo(url, targetDir, prompt, model = '', signal = null) {
    const { buffer, contentType, finalUrl } = await downloadGeneratedBuffer(url, {
        signal,
        accept: 'video/*,application/octet-stream;q=0.9,*/*;q=0.1'
    });
    const filePath = path.join(targetDir, uniqueVideoName(
        videoModelFilePrefix(model), prompt, videoExtensionFromUrl(finalUrl, contentType)
    ));
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

async function downloadGeneratedBuffer(url, {
    headers,
    signal,
    accept = 'application/octet-stream,*/*;q=0.1'
} = {}) {
    let lastError;
    let http1FallbackAttempts = 0;
    let attemptsMade = 0;
    for (let attempt = 0; attempt < GENERATED_MEDIA_DOWNLOAD_ATTEMPTS; attempt += 1) {
        attemptsMade = attempt + 1;
        throwIfGenerationCanceled(signal);
        const linked = createLinkedAbortController(signal, 180000);
        try {
            const response = await net.fetch(url, {
                method: 'GET',
                headers,
                redirect: 'follow',
                signal: linked.controller.signal
            });
            if (!response.ok) {
                const error = generatedMediaDownloadHttpError(response.status);
                await response.body?.cancel();
                throw error;
            }
            const declaredLength = Number(response.headers.get('content-length'));
            if (Number.isFinite(declaredLength) && declaredLength > GENERATED_MEDIA_DOWNLOAD_MAX_BYTES) {
                await response.body?.cancel();
                throw Object.assign(new Error('生成产物超过 512 MB 下载限制'), { retryable: false });
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            if (!buffer.length) throw new Error('服务器返回了空生成产物');
            return {
                buffer,
                contentType: response.headers.get('content-type') || '',
                finalUrl: response.url || url
            };
        } catch (error) {
            throwIfGenerationCanceled(signal);
            lastError = error;
            if (shouldFallbackToHttp1GeneratedMediaDownload(error)) {
                http1FallbackAttempts += 1;
                try {
                    const fallback = await downloadRemoteBinaryOverHttp1(url, signal, accept, headers);
                    if (!fallback.buffer.length) throw new Error('服务器返回了空生成产物');
                    return {
                        buffer: fallback.buffer,
                        contentType: fallback.contentType,
                        finalUrl: fallback.url
                    };
                } catch (fallbackError) {
                    throwIfGenerationCanceled(signal);
                    lastError = fallbackError;
                    if (!isRetryableGeneratedMediaDownloadError(fallbackError)) break;
                }
            } else if (!isRetryableGeneratedMediaDownloadError(error)) {
                break;
            }
        } finally {
            linked.cleanup();
        }
        if (attempt < GENERATED_MEDIA_DOWNLOAD_ATTEMPTS - 1) {
            await sleep(GENERATED_MEDIA_DOWNLOAD_RETRY_DELAY_MS * (attempt + 1), signal);
        }
    }
    const fallbackText = http1FallbackAttempts > 0 ? `，其中 HTTP/1.1 回退 ${http1FallbackAttempts} 次` : '';
    throw new Error(`下载生成产物失败（${describeRemoteEndpoint(url)}，已尝试 ${attemptsMade} 次${fallbackText}）：${describeRemoteFailure(lastError)}。可使用“继续下载”再次拉取产物。`);
}

function generatedMediaDownloadHttpError(status) {
    const error = new Error(`HTTP ${status}`);
    error.status = Number(status);
    return error;
}

function isRetryableGeneratedMediaDownloadError(error) {
    const status = Number(error?.status);
    if (Number.isFinite(status) && status > 0) {
        return [408, 425, 429, 500, 502, 503, 504].includes(status);
    }
    const marker = `${error?.code || ''} ${error?.message || error || ''}`;
    return !/产物超过 512 MB|不支持的产物下载协议|重定向超过/.test(marker);
}

function shouldFallbackToHttp1GeneratedMediaDownload(error) {
    const marker = `${error?.code || ''} ${error?.message || error || ''}`;
    return /quic|http.?2|http.?3|ERR_HTTP2|ERR_HTTP3|ERR_QUIC_PROTOCOL_ERROR/i.test(marker);
}

async function downloadRemoteBinaryOverHttp1(
    rawUrl,
    signal = null,
    accept = 'application/octet-stream,*/*;q=0.1',
    requestHeaders = {},
    redirects = 0
) {
    throwIfGenerationCanceled(signal);
    const url = new URL(rawUrl);
    const transport = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
    if (!transport) throw new Error(`不支持的产物下载协议：${url.protocol}`);

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (handler, value) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener?.('abort', abort);
            handler(value);
        };
        const fail = error => finish(reject, error);
        const abort = () => {
            request.destroy(generationCanceledError());
            fail(generationCanceledError());
        };
        const request = transport.get(url, {
            headers: {
                ...requestHeaders,
                Accept: accept,
                'Accept-Encoding': 'identity'
            }
        }, response => {
            const status = Number(response.statusCode) || 0;
            const location = response.headers.location;
            if ([301, 302, 303, 307, 308].includes(status) && location) {
                response.resume();
                if (redirects >= GENERATED_MEDIA_DOWNLOAD_REDIRECT_LIMIT) {
                    fail(new Error(`产物下载重定向超过 ${GENERATED_MEDIA_DOWNLOAD_REDIRECT_LIMIT} 次`));
                    return;
                }
                downloadRemoteBinaryOverHttp1(new URL(location, url).toString(), signal, accept, requestHeaders, redirects + 1)
                    .then(value => finish(resolve, value), fail);
                return;
            }
            if (status < 200 || status >= 300) {
                response.resume();
                fail(generatedMediaDownloadHttpError(status));
                return;
            }

            const declaredLength = Number(response.headers['content-length']);
            if (Number.isFinite(declaredLength) && declaredLength > GENERATED_MEDIA_DOWNLOAD_MAX_BYTES) {
                response.resume();
                fail(new Error('生成产物超过 512 MB 下载限制'));
                return;
            }

            const chunks = [];
            let totalBytes = 0;
            response.on('data', chunk => {
                totalBytes += chunk.length;
                if (totalBytes > GENERATED_MEDIA_DOWNLOAD_MAX_BYTES) {
                    const error = new Error('生成产物超过 512 MB 下载限制');
                    response.destroy(error);
                    fail(error);
                    return;
                }
                chunks.push(chunk);
            });
            response.once('error', fail);
            response.once('aborted', () => fail(new Error('生成产物下载连接被服务器中断')));
            response.once('end', () => finish(resolve, {
                buffer: Buffer.concat(chunks),
                contentType: String(response.headers['content-type'] || ''),
                url: url.toString()
            }));
        });
        request.setTimeout(GENERATED_MEDIA_DOWNLOAD_HTTP1_TIMEOUT_MS, () => {
            request.destroy(new Error('HTTP/1.1 产物下载超时'));
        });
        request.once('error', fail);
        if (signal?.aborted) {
            abort();
        } else {
            signal?.addEventListener?.('abort', abort, { once: true });
        }
    });
}

async function tryGenerateWithOpenAIVideo(prompt, targetDir, options = {}) {
    try {
        throwIfGenerationCanceled(options.signal);
        options.onProgress?.({ stage: 'prepare' });
        const providerConfig = options.providerConfig || {};
        const apiKey = String(providerConfig.apiKey || process.env.FLOW_CANVAS_VIDEO_API_KEY || '').trim();
        const model = String(providerConfig.model || options.model || process.env.FLOW_CANVAS_VIDEO_MODEL || 'doubao-seedance-2-0').trim();
        let endpoint = buildVideoGenerationEndpoint(
            providerConfig.endpoint || process.env.FLOW_CANVAS_VIDEO_ENDPOINT,
            model
        );
        if (!apiKey) return { success: false, error: '\u672a\u914d\u7f6e\u89c6\u9891 API Key' };
        if (!endpoint) return { success: false, error: '\u672a\u914d\u7f6e\u89c6\u9891 API \u5730\u5740' };

        const isMiniMaxH3 = isMiniMaxH3Model(model);
        const isSeedance25 = isSeedance25Model(model);
        const body = { model, prompt };
        const resolution = String(options.resolution || '').trim();
        let ratio = String(options.ratio || '').trim();
        const duration = Number(options.duration);
        if (isSeedance25 && (!ratio || ratio === 'adaptive')) {
            const firstReference = options.sourceReferences?.[0] || null;
            let width = Number(firstReference?.width);
            let height = Number(firstReference?.height);
            if ((!(width > 0) || !(height > 0)) && firstReference?.filePath) {
                const metadata = await sharp(String(firstReference.filePath)).rotate().metadata().catch(() => ({}));
                width = Number(metadata.width);
                height = Number(metadata.height);
            }
            ratio = resolveSeedance25AspectRatio(ratio, width, height);
        }
        if (isMiniMaxH3) {
            Object.assign(body, buildMiniMaxH3RequestBody({
                endpoint,
                model,
                prompt,
                duration: Number.isInteger(duration) ? duration : undefined,
                aspectRatio: ratio || undefined,
                resolution: resolution || undefined
            }));
        } else if (isSeedance25) {
            Object.assign(body, buildSeedance25RequestBody({
                endpoint,
                model,
                prompt,
                duration: Number.isInteger(duration) ? duration : undefined,
                aspectRatio: ratio || undefined
            }));
        } else {
            if (resolution) body.resolution = resolution;
            if (ratio) body.ratio = ratio;
            if (Number.isInteger(duration)) body.duration = duration;
            if (typeof options.cameraFixed === 'boolean') body.camera_fixed = options.cameraFixed;
            if (typeof options.generateAudio === 'boolean') body.generate_audio = options.generateAudio;
            const webSearch = options.webSearch ?? options.web_search;
            if (typeof webSearch === 'boolean') body.web_search = webSearch;
            if (typeof options.watermark === 'boolean') body.watermark = options.watermark;
        }

        const videoReferences = options.videoReferences || [];
        const images = await collectVideoReferenceImages(
            options.sourceReferences || [],
            options.compressReferenceImages === true,
            isSeedance25 ? seedance25ReferenceImageLimit(model) : 9
        );
        throwIfGenerationCanceled(options.signal);
        const videos = isSeedance25
            ? []
            : collectVideoReferenceVideos(
                videoReferences,
                isMiniMaxH3 ? 50 * 1024 * 1024 : 128 * 1024 * 1024
            );
        const audioUrls = isSeedance25
            ? []
            : collectVideoReferenceAudio(
                options.audioReferences || [],
                3,
                isMiniMaxH3 ? 15 * 1024 * 1024 : 32 * 1024 * 1024
            );
        const uploadProviders = temporaryUploadProviders(providerConfig);
        const imageUrls = await uploadVideoReferencesOrUseOriginals(
            images.map(image => image.url),
            '参考图片',
            uploadProviders,
            options.onProgress
        );
        throwIfGenerationCanceled(options.signal);
        const referenceVideoUrls = await uploadVideoReferencesOrUseOriginals(
            videos,
            '参考视频',
            uploadProviders,
            options.onProgress
        );
        throwIfGenerationCanceled(options.signal);
        const referenceAudioUrls = await uploadVideoReferencesOrUseOriginals(
            audioUrls,
            '参考音频',
            uploadProviders,
            options.onProgress
        );
        throwIfGenerationCanceled(options.signal);
        if (isMiniMaxH3) {
            Object.assign(body, buildMiniMaxH3RequestBody({
                endpoint,
                model,
                prompt,
                duration: Number.isInteger(duration) ? duration : undefined,
                aspectRatio: ratio || undefined,
                resolution: resolution || undefined,
                referenceImages: imageUrls,
                referenceVideos: referenceVideoUrls,
                referenceAudios: referenceAudioUrls
            }));
        } else if (isSeedance25) {
            Object.assign(body, buildSeedance25RequestBody({
                endpoint,
                model,
                prompt,
                duration: Number.isInteger(duration) ? duration : undefined,
                aspectRatio: ratio || undefined,
                referenceImages: imageUrls
            }));
        } else {
            if (images.length > 0) {
                body.images = images.map((image, index) => ({
                    ...image,
                    url: imageUrls[index] || image.url
                }));
            }
            if (referenceVideoUrls.length > 0) body.videos = referenceVideoUrls;
            if (referenceAudioUrls.length > 0) body.audio_urls = referenceAudioUrls;
        }

        const recoveryId = createVideoRecoveryId();
        let response;
        let text;
        let initialResponse;
        let recoveringSubmission = false;
        options.onProgress?.({ stage: 'submit' });
        console.info('[FlowCanvasBridge] Video request:', JSON.stringify(summarizeVideoRequest(endpoint, body, recoveryId)));
        try {
            response = await net.fetch(endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'X-Playground': '1',
                    'X-Log-Id': recoveryId
                },
                body: JSON.stringify(body),
                redirect: 'follow',
                signal: options.signal
            });
            text = await response.text();
        } catch (error) {
            throwIfGenerationCanceled(options.signal);
            if (!isAmbiguousVideoSubmitError(error)) {
                throw remoteConnectionError('\u63d0\u4ea4\u89c6\u9891\u751f\u6210\u4efb\u52a1', endpoint, error);
            }
            recoveringSubmission = true;
            initialResponse = {
                id: recoveryId,
                task_id: recoveryId,
                status: 'pending',
                recovering: true
            };
            console.warn('[FlowCanvasBridge] Video submit response disconnected; recovering by log ID:', recoveryId);
        }
        if (response && !response.ok) {
            const serverTraceId = response.headers.get('x-log-id')
                || response.headers.get('x-request-id')
                || response.headers.get('request-id')
                || recoveryId;
            if (isMiniMaxH3 && isMiniMaxH3UnavailableResponse(response.status, text)) {
                return {
                    success: false,
                    error: `MiniMax H3 在当前 API 的模型列表中可见，但没有可用生成渠道（${describeRemoteEndpoint(endpoint)}）。请检查中转站模型映射是否为 minimax-h3 -> MiniMax-H3-c1；Flow Canvas 不会绕过中转站直连其他域名。`
                };
            }
            return {
                success: false,
                error: `\u63d0\u4ea4\u89c6\u9891\u751f\u6210\u4efb\u52a1\u5931\u8d25\uff08${describeRemoteEndpoint(endpoint)}\uff09\uff1aHTTP ${response.status} ${text.slice(0, 1000)}\uff1b\u8bf7\u6c42\u8ffd\u8e2a ID ${serverTraceId}`
            };
        }

        if (!initialResponse) {
            try {
                initialResponse = JSON.parse(text);
            } catch (_) {
                return { success: false, error: '\u63d0\u4ea4\u89c6\u9891\u4efb\u52a1\u540e\uff0c\u670d\u52a1\u5668\u672a\u8fd4\u56de\u6709\u6548 JSON' };
            }
        }
        const taskId = getVideoTaskId(initialResponse);
        if (!taskId && !getVideoResultUrl(initialResponse)) {
            const reason = getVideoPayloadError(initialResponse)
                || '服务端没有返回任务 ID 或视频地址';
            return {
                success: false,
                error: formatVideoTaskFailure(reason, describeRemoteEndpoint(endpoint), '提交视频生成任务失败')
            };
        }
        if (taskId) {
            try {
                options.onTaskSubmitted?.({
                    taskId,
                    model,
                    initialResponse,
                    recovering: recoveringSubmission
                });
            } catch (error) {
                console.warn('[FlowCanvasBridge] Failed to persist submitted video task:', error.message);
            }
        }
        const completed = await pollOpenAiVideoTask(endpoint, apiKey, taskId, initialResponse, {
            model,
            preferVideoTaskEndpoint: isMiniMaxH3 || isSeedance25,
            signal: options.signal,
            onTaskIdResolved: (resolvedTaskId, payload) => options.onTaskSubmitted?.({
                taskId: resolvedTaskId,
                model,
                initialResponse: payload,
                recovered: recoveringSubmission
            }),
            onProgress: options.onProgress
        });
        throwIfGenerationCanceled(options.signal);
        options.onProgress?.({ stage: 'download' });
        const filePath = await downloadVideo(completed.url, targetDir, prompt, model, options.signal);
        options.onDownloaded?.({ filePath, filePaths: [filePath], taskId: completed.taskId || taskId,
            mediaType: 'video', video: { url: completed.url }, targetDir });
        throwIfGenerationCanceled(options.signal);
        options.onProgress?.({ stage: 'completed' });
        return {
            success: true,
            provider: 'openai-video',
            taskId: completed.taskId || taskId,
            url: completed.url,
            filePath,
            width: Number(options.width) || undefined,
            height: Number(options.height) || undefined
        };
    } catch (error) {
        return { success: false, error: error.message || String(error) };
    }
}

async function generateBuiltinPlaceholder(prompt, targetDir, options = {}) {
    const width = sanitizeImageDimension(options.width, 1024);
    const height = sanitizeImageDimension(options.height, 1024);
    const title = String(options.title || 'Flow Canvas 内置生图').trim();
    const sourceThumbnails = await createSourceThumbnails(options.sourceReferences || []);
    const svg = createPromptSvg({ prompt, title, width, height, sourceThumbnails });
    const filePath = path.join(targetDir, uniqueImageName('flow_builtin', prompt, '.png'));
    const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
    fs.writeFileSync(filePath, buffer);
    return {
        success: true,
        provider: 'builtin',
        filePath,
        width,
        height
    };
}

async function createSourceThumbnails(sourceReferences = []) {
    const thumbnails = [];
    for (const reference of sourceReferences.slice(0, 3)) {
        try {
            const buffer = await sharp(reference.filePath)
                .rotate()
                .resize(180, 150, { fit: 'cover' })
                .png()
                .toBuffer();
            thumbnails.push({
                ...reference,
                dataUri: `data:image/png;base64,${buffer.toString('base64')}`
            });
        } catch (error) {
            thumbnails.push({ ...reference, error: error.message });
        }
    }
    return thumbnails;
}

function createPromptSvg({ prompt, title, width, height, sourceThumbnails = [] }) {
    const hasSources = sourceThumbnails.length > 0;
    const lines = wrapText(prompt, 30).slice(0, hasSources ? 8 : 12);
    const titleSafe = escapeXml(title);
    const promptText = lines.map((line, index) =>
        `<text x="72" y="${210 + index * 42}" class="prompt">${escapeXml(line)}</text>`
    ).join('');
    const sourceY = Math.max(560, height - 250);
    const sourceCards = sourceThumbnails.map((reference, index) => {
        const x = 72 + index * 230;
        const labelLines = wrapText(reference.name || path.basename(reference.filePath), 18).slice(0, 2);
        const labelText = labelLines.map((line, lineIndex) =>
            `<text x="${x}" y="${sourceY + 178 + lineIndex * 22}" class="sourceName">${escapeXml(line)}</text>`
        ).join('');
        const imageMarkup = reference.dataUri
            ? `<image href="${reference.dataUri}" x="${x}" y="${sourceY}" width="180" height="150" preserveAspectRatio="xMidYMid slice"/>`
            : `<rect x="${x}" y="${sourceY}" width="180" height="150" rx="18" fill="#d8e1e5"/><text x="${x + 18}" y="${sourceY + 78}" class="sourceName">missing</text>`;
        return `
          <g>
            <rect x="${x - 10}" y="${sourceY - 10}" width="200" height="232" rx="22" fill="rgba(255,255,255,0.55)" stroke="rgba(56,80,90,0.18)"/>
            ${imageMarkup}
            ${labelText}
          </g>`;
    }).join('');
    const sourceBlock = hasSources
        ? `<text x="72" y="${sourceY - 28}" class="meta">Source assets read from the connected planning row</text>${sourceCards}`
        : '<text x="72" y="152" class="meta">Generated locally when no external image API is configured</text>';
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f7f3ea"/>
      <stop offset="0.48" stop-color="#dbe8f0"/>
      <stop offset="1" stop-color="#d9ede3"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#24404d" flood-opacity="0.18"/>
    </filter>
    <style>
      .label { font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif; font-size: 28px; fill: #38505a; font-weight: 700; }
      .prompt { font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif; font-size: 31px; fill: #10242d; font-weight: 650; }
      .meta { font-family: "Segoe UI", Arial, sans-serif; font-size: 18px; fill: #5d6f77; letter-spacing: 0; }
      .sourceName { font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif; font-size: 18px; fill: #314852; font-weight: 600; }
    </style>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect x="44" y="44" width="${width - 88}" height="${height - 88}" rx="30" fill="rgba(255,255,255,0.62)" filter="url(#shadow)"/>
  <circle cx="${width - 170}" cy="148" r="62" fill="#f5b971" opacity="0.72"/>
  <rect x="${width - 300}" y="${height - 220}" width="210" height="120" rx="26" fill="#6db5a6" opacity="0.52"/>
  <path d="M84 ${height - 170} C 180 ${height - 280}, 320 ${height - 90}, 470 ${height - 190} S 710 ${height - 230}, ${width - 84} ${height - 130}" fill="none" stroke="#507f9a" stroke-width="8" opacity="0.28"/>
  <text x="72" y="110" class="label">${titleSafe}</text>
  ${sourceBlock}
  ${promptText}
</svg>`;
}

function wrapText(text, maxChars) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return [];
    const tokens = normalized.match(/[\u4e00-\u9fff]|[^\s\u4e00-\u9fff]+/g) || [normalized];
    const lines = [];
    let line = '';
    tokens.forEach(token => {
        const candidate = line ? `${line}${/^[\u4e00-\u9fff]$/.test(token) ? '' : ' '}${token}` : token;
        if (candidate.length > maxChars && line) {
            lines.push(line);
            line = token;
        } else {
            line = candidate;
        }
    });
    if (line) lines.push(line);
    return lines;
}

function uniqueImageName(prefix, prompt, ext) {
    const hash = crypto.createHash('sha1').update(`${Date.now()}:${prompt}:${Math.random()}`).digest('hex').slice(0, 12);
    return `${prefix}_${hash}${IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) ? ext : '.png'}`;
}

function sanitizeImageDimension(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(256, Math.min(2048, Math.round(number)));
}

function sanitizeHost(host) {
    const value = String(host || DEFAULT_MCP_CONFIG.host).trim();
    return value === 'localhost' ? '127.0.0.1' : value;
}

function sanitizePort(port) {
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) return DEFAULT_MCP_CONFIG.port;
    return value;
}

function sanitizeBoardToolTimeout(value) {
    const timeout = Number(value);
    if (!Number.isFinite(timeout) || timeout < 10) return BOARD_TOOL_REQUEST_TIMEOUT_MS;
    return Math.min(Math.round(timeout), 120_000);
}

function createBridgeError(code, message, details = null, status = null) {
    const error = new Error(String(message || 'Flow Canvas bridge request failed'));
    error.code = String(code || 'BRIDGE_ERROR');
    error.details = details == null ? null : clone(details);
    error.status = status != null && Number.isInteger(Number(status)) ? Number(status) : bridgeErrorStatus(error.code);
    return error;
}

function bridgeErrorStatus(code) {
    if (code === 'REVISION_CONFLICT') return 409;
    if (code === 'TOOL_NOT_FOUND') return 404;
    if (code.startsWith('INVALID_') || code === 'TOO_MANY_OPERATIONS' || code === 'PROJECT_MISMATCH') return 400;
    if (code === 'BOARD_TOOL_TIMEOUT') return 504;
    if (['RENDERER_NOT_READY', 'RENDERER_RELOADING', 'RENDERER_UNAVAILABLE', 'TOOL_UNAVAILABLE', 'BRIDGE_STOPPED'].includes(code)) return 503;
    return 500;
}

function serializeBridgeError(error) {
    const code = String(error?.code || 'BRIDGE_ERROR');
    return {
        code,
        message: String(error?.message || 'Flow Canvas bridge request failed'),
        details: error?.details == null ? null : clone(error.details),
        status: Number.isInteger(Number(error?.status)) ? Number(error.status) : bridgeErrorStatus(code)
    };
}

function sanitizeAllowedTools(allowedTools) {
    const source = Array.isArray(allowedTools) ? allowedTools : DEFAULT_MCP_CONFIG.allowedTools;
    const tools = new Set(
        source
            .map(toolName => String(toolName || '').trim())
            .filter(toolName => KNOWN_TOOL_NAMES.has(toolName))
    );

    MANAGEMENT_TOOL_NAMES.forEach(toolName => tools.add(toolName));

    const isLegacyDefault = LEGACY_DEFAULT_TOOL_NAMES.every(toolName => tools.has(toolName));
    if (isLegacyDefault) {
        DEFAULT_MCP_CONFIG.allowedTools.forEach(toolName => tools.add(toolName));
    }

    return [...tools];
}

function sanitizeConfigPatch(patch = {}) {
    const next = {};
    if (patch.enabled !== undefined) {
        next.enabled = patch.enabled === true;
    }
    if (patch.port !== undefined) {
        next.port = sanitizePort(patch.port);
    }
    if (patch.allowedTools !== undefined) {
        next.allowedTools = sanitizeAllowedTools(patch.allowedTools);
    }
    return next;
}

function resolveWritableTargetDir(requestedTargetDir, fallbackDir) {
    try {
        const targetDir = path.resolve(String(requestedTargetDir));
        assertWritableDir(targetDir);
        return { targetDir, fallbackReason: null };
    } catch (error) {
        const targetDir = path.resolve(fallbackDir || path.join(process.cwd(), 'output'));
        assertWritableDir(targetDir);
        return {
            targetDir,
            fallbackReason: `Requested directory was not writable: ${error.message}`
        };
    }
}

function assertWritableDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    const probePath = path.join(dirPath, `.flow-canvas-write-test-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(probePath, '');
    try {
        fs.unlinkSync(probePath);
    } catch (_) {
        // Best effort cleanup; successful write already proved the directory is usable.
    }
}

function isLocalAddress(address) {
    return !address
        || address === '127.0.0.1'
        || address === '::1'
        || address === '::ffff:127.0.0.1';
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        if (req.method === 'GET' || req.method === 'DELETE') {
            resolve(null);
            return;
        }
        const chunks = [];
        req.on('data', chunk => {
            chunks.push(chunk);
            if (Buffer.concat(chunks).length > 5 * 1024 * 1024) {
                req.destroy();
                reject(new Error('Request body too large'));
            }
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            if (!raw) {
                resolve(null);
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (error) {
                reject(new Error(`Invalid JSON body: ${error.message}`));
            }
        });
        req.on('error', reject);
    });
}

function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

module.exports = FlowCanvasBridge;
module.exports.pollOpenAiImageTask = pollOpenAiImageTask;
module.exports.pollOpenAiVideoTask = pollOpenAiVideoTask;
