const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const { app, net } = require('electron');
const { PlanService, DEFAULT_MCP_CONFIG } = require('../shared/plan-service-core.cjs');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.aac', '.flac', '.ogg']);
const VIDEO_REFERENCE_UPLOAD_BUDGET_BYTES = 8 * 1024 * 1024;
const VIDEO_REFERENCE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TEMP_REFERENCE_UPLOAD_ENDPOINT = 'https://litterbox.catbox.moe/resources/internals/api.php';
const TEMP_REFERENCE_CACHE_TTL_MS = 50 * 60 * 1000;
const TEMP_REFERENCE_UPLOAD_MAX_ATTEMPTS = 3;
const temporaryReferenceUrlCache = new Map();
const DEFAULT_IMAGE_SIZE_OPTIONS = ['1024x1024', '1536x1024', '1024x1536'];
const RAVENHASH_IMAGE_SIZE_OPTIONS = [
    ...DEFAULT_IMAGE_SIZE_OPTIONS,
    '2048x2048',
    '2880x2880',
    '3840x2160',
    '2160x3840'
];
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
    constructor({ store, getMainWindow, getDefaultSaveFolder, getFallbackSaveDir, notifyRenderer, notifyTaskSubmitted, notifyTaskCompleted }) {
        this.store = store;
        this.getMainWindow = getMainWindow;
        this.getDefaultSaveFolder = getDefaultSaveFolder;
        this.getFallbackSaveDir = getFallbackSaveDir;
        this.notifyRenderer = notifyRenderer;
        this.notifyTaskSubmitted = notifyTaskSubmitted;
        this.notifyTaskCompleted = notifyTaskCompleted;
        this.server = null;
        this.host = DEFAULT_MCP_CONFIG.host;
        this.port = DEFAULT_MCP_CONFIG.port;
        this.allowedTools = new Set(DEFAULT_MCP_CONFIG.allowedTools);
        this.boardMutationQueue = Promise.resolve();
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
                this._sendJson(res, 500, { success: false, error: error.message });
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
        if (!this.server) return;
        this.server.close();
        this.server = null;
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

    _saveAndNotify(data, event = 'mcp:update') {
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
        this._saveAndNotify(data, 'mcp:config-updated');
        return {
            config: next,
            runtime: {
                host: this.host,
                port: this.port,
                enabled: Boolean(this.server),
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
        const prompt = String(body?.prompt || '').trim();
        if (!prompt) throw new Error('Missing prompt');
        const { data, planService } = this._loadWithPlanService();
        const requestedTargetDir = body?.targetDir || this.getDefaultSaveFolder?.(data) || this.getFallbackSaveDir?.();
        if (!requestedTargetDir) throw new Error('No save directory available for generated image');
        const targetInfo = resolveWritableTargetDir(requestedTargetDir, this.getFallbackSaveDir?.());
        const targetDir = targetInfo.targetDir;

        const sourceContext = collectImageSourceReferences(data, planService, body);
        const generationOptions = await resolveImageGenerationOptions({
            ...body,
            sourceReferences: sourceContext.references
        });

        let result = null;
        if (body.provider !== 'builtin') {
            result = await tryGenerateWithOpenAI(prompt, targetDir, generationOptions);
            if (!result?.success && (body.provider || body.providerConfig)) {
                throw new Error(result?.error || 'Image generation API failed');
            }
        }
        if (!result?.success) {
            result = await generateBuiltinPlaceholder(prompt, targetDir, generationOptions);
        }

        const committed = await this._commitBoardMutation(async () => {
            const { data: latestData, planService: latestPlanService } = this._loadWithPlanService();
            const shouldAddToCanvas = result.provider !== 'builtin' || body.addToCanvas === true;
            const item = shouldAddToCanvas
                ? addBoardItem(latestData, result.filePath, {
                    x: body.x,
                    y: body.y,
                    width: result.width,
                    height: result.height
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

            this._saveAndNotify(latestData, 'mcp:image-generated');
            return {
                item,
                plan: body.planId ? latestPlanService.getPlan(body.planId) : null
            };
        });
        return {
            item: committed.item,
            filePath: result.filePath,
            provider: result.provider,
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
            sourceReferences: sourceContext.references,
            videoReferences: videoSourceContext.references,
            audioReferences: audioSourceContext.references,
            onTaskSubmitted: ({ taskId, model, recovering, recovered }) => this.notifyTaskSubmitted?.({
                clientTaskId: body.clientTaskId || null,
                remoteTaskId: taskId,
                targetDir,
                model,
                prompt,
                recovering: recovering === true,
                recovered: recovered === true,
                createdAt: new Date().toISOString()
            })
        });
        if (!result?.success) throw new Error(result?.error || '\u89c6\u9891\u751f\u6210 API \u8bf7\u6c42\u5931\u8d25');
        this.notifyTaskCompleted?.({
            remoteTaskId: result.taskId,
            filePath: result.filePath
        });

        const committed = await this._commitBoardMutation(async () => {
            const { data: latestData, planService: latestPlanService } = this._loadWithPlanService();
            const item = body.addToCanvas === false
                ? null
                : addBoardItem(latestData, result.filePath, {
                    x: body.x,
                    y: body.y,
                    width: result.width,
                    height: result.height
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

            this._saveAndNotify(latestData, 'mcp:video-generated');
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
        const temporaryTargetDir = path.join(app.getPath('temp'), 'flow-canvas-reference-compression');
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

            const compressed = await compressVideoReferenceImage(sourcePath, targetBytes);
            const extension = compressed.mimeType === 'image/webp' ? '.webp' : '.jpg';
            const filePath = path.join(
                targetDir,
                uniqueImageName('flow_compressed', path.basename(sourcePath, path.extname(sourcePath)), extension)
            );
            await fs.promises.writeFile(filePath, compressed.buffer);
            const metadata = await sharp(compressed.buffer).metadata();
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
                compressedBytes: compressed.buffer.length,
                width: metadata.width || null,
                height: metadata.height || null
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
        const taskId = String(body?.taskId || '').trim();
        if (!taskId) throw new Error('\u7f3a\u5c11\u53ef\u6062\u590d\u7684\u89c6\u9891\u4efb\u52a1 ID');
        const prompt = String(body?.prompt || '').trim();
        const providerConfig = body?.providerConfig || {};
        const apiKey = String(providerConfig.apiKey || process.env.FLOW_CANVAS_VIDEO_API_KEY || '').trim();
        const endpoint = buildOpenAiVideoEndpoint(providerConfig.endpoint || process.env.FLOW_CANVAS_VIDEO_ENDPOINT);
        const model = String(providerConfig.model || body?.model || process.env.FLOW_CANVAS_VIDEO_MODEL || '').trim();
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
                preferVideoTaskEndpoint: isMiniMaxH3Model(model),
                onTaskIdResolved: (resolvedTaskId) => this.notifyTaskSubmitted?.({
                    clientTaskId: body.clientTaskId || null,
                    remoteTaskId: resolvedTaskId,
                    targetDir,
                    model,
                    prompt,
                    recovered: true,
                    createdAt: new Date().toISOString()
                })
            }
        );
        const resolvedTaskId = completed.taskId || taskId;
        const filePath = await downloadVideo(completed.url, targetDir, prompt);
        this.notifyTaskCompleted?.({ remoteTaskId: resolvedTaskId, filePath });
        const item = body.addToCanvas === false
            ? null
            : addBoardItem(data, filePath, { x: body.x, y: body.y });
        this._saveAndNotify(data, 'mcp:video-recovered');
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

function addBoardItem(data, filePath, options = {}) {
    if (!Array.isArray(data.items)) data.items = [];
    restoreRemovedBoardPath(data, filePath);
    const existing = data.items.find(item => item.filePath === filePath);
    if (existing) return existing;

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

function collectImageSourceReferences(data, planService, body = {}) {
    const requested = Array.isArray(body.sourceReferences) ? body.sourceReferences : [];
    const references = [];
    const missing = [];
    const pushReference = reference => {
        const normalized = normalizeSourceReference(reference, data);
        if (!normalized) return;
        if (references.some(existing => normalizeFsPath(existing.filePath) === normalizeFsPath(normalized.filePath))) return;
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
        kind: reference.kind ? String(reference.kind) : (reference.role ? String(reference.role) : 'source')
    };
}

function toRowReference(reference) {
    return {
        itemId: reference.itemId || '',
        filePath: reference.filePath,
        name: reference.name || path.basename(reference.filePath),
        kind: reference.kind || 'source'
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

function collectImageEditInputs(sourceReferences = []) {
    return sourceReferences.map(reference => {
        const filePath = String(reference?.filePath || '').trim();
        const stats = fs.statSync(filePath);
        if (stats.size > 50 * 1024 * 1024) {
            throw new Error(`Image reference is larger than 50 MB: ${path.basename(filePath)}`);
        }
        const extension = path.extname(filePath).toLowerCase();
        const mimeType = extension === '.png'
            ? 'image/png'
            : extension === '.webp'
                ? 'image/webp'
                : 'image/jpeg';
        const base64 = fs.readFileSync(filePath).toString('base64');
        return {
            image_url: `data:${mimeType};base64,${base64}`
        };
    });
}

async function resolveGeneratedImageBuffer(image, endpoint) {
    const base64Value = String(image?.b64_json || image?.base64 || '').trim();
    if (base64Value) return Buffer.from(base64Value.replace(/\s+/g, ''), 'base64');

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
    const imageRes = await net.fetch(imageUrl, { redirect: 'follow' });
    if (!imageRes.ok) throw new Error(`Image download failed: ${imageRes.status}`);
    return Buffer.from(await imageRes.arrayBuffer());
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
        const endpoint = buildOpenAiImageEndpoint(providerConfig.endpoint, isEdit ? 'edits' : 'generations');
        const model = process.env.FLOW_CANVAS_IMAGE_MODEL || providerConfig.model || options.model || 'gpt-image-2';
        const size = String(options.size || '').trim().replace(/\u00d7/g, 'x');
        const requestedQuality = String(options.quality || 'high').trim().toLowerCase();
        const quality = ['auto', 'low', 'medium', 'high'].includes(requestedQuality) ? requestedQuality : 'high';
        const requestBody = {
            model,
            prompt,
            n: Math.min(8, Math.max(1, Number(options.n) || 1)),
            quality,
            response_format: options.responseFormat === 'b64_json' ? 'b64_json' : 'url',
            stream: false
        };
        if (size) requestBody.size = size;
        if (isEdit) {
            requestBody.images = sourceImages;
        } else {
            requestBody.history_disabled = options.historyDisabled !== false;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000);
        const requestId = options.requestId || crypto.randomUUID?.() || crypto.randomBytes(16).toString('hex');
        let res;
        try {
            res = await net.fetch(endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'Idempotency-Key': requestId,
                    'X-Log-Id': requestId
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal,
                redirect: 'follow'
            });
        } finally {
            clearTimeout(timeoutId);
        }
        if (!res.ok) {
            const text = await res.text();
            if (res.status === 413) {
                return {
                    success: false,
                    error: '参考图片总大小超过 API 网关限制（HTTP 413）。请使用“批量转小”后重试。'
                };
            }
            return { success: false, error: `Image API failed: ${res.status} ${text.slice(0, 2000)}` };
        }
        const json = await res.json();
        const image = json?.data?.[0];
        const buffer = await resolveGeneratedImageBuffer(image, endpoint);
        if (!buffer) return { success: false, error: 'OpenAI response did not include image data' };
        const metadata = await sharp(buffer).metadata().catch(() => ({}));
        const extension = metadata.format === 'jpeg'
            ? '.jpg'
            : metadata.format === 'webp'
                ? '.webp'
                : metadata.format === 'avif'
                    ? '.avif'
                    : '.png';
        const filePath = path.join(targetDir, uniqueImageName('ai', prompt, extension));
        fs.writeFileSync(filePath, buffer);
        const actualSize = metadata.width && metadata.height ? `${metadata.width}x${metadata.height}` : null;
        return {
            success: true,
            provider: 'openai',
            filePath,
            width: metadata.width || 1024,
            height: metadata.height || 1024,
            requestedSize: size || null,
            actualSize,
            sizeMatchesRequest: !size || !actualSize || actualSize.toLowerCase() === size.toLowerCase(),
            endpointMode: isEdit ? 'edits' : 'generations'
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function buildOpenAiVideoEndpoint(endpoint) {
    const raw = String(endpoint || process.env.FLOW_CANVAS_VIDEO_ENDPOINT || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        let pathName = url.pathname.replace(/\/+$/, '');
        if (!pathName || pathName === '/') {
            pathName = '/v1/video/generations';
        } else if (/\/v1$/i.test(pathName)) {
            pathName += '/video/generations';
        } else if (/\/(?:chat\/completions|responses|completions|models|images\/(?:generations|edits))$/i.test(pathName)) {
            pathName = pathName.replace(/\/(?:chat\/completions|responses|completions|models|images\/(?:generations|edits))$/i, '/video/generations');
        } else if (!/\/video\/generations$/i.test(pathName)) {
            pathName += '/video/generations';
        }
        url.pathname = pathName;
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch (_) {
        return raw;
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
        try {
            const response = await net.fetch(url, options);
            const text = await response.text();
            return { response, text };
        } catch (error) {
            lastError = error;
            if (attempt < attempts - 1) await sleep(750 * (attempt + 1));
        }
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

function collectVideoReferenceVideos(videoReferences = []) {
    return videoReferences.slice(0, 3).map(reference => {
        const filePath = String(reference?.filePath || '');
        const size = fs.statSync(filePath).size;
        if (size > 128 * 1024 * 1024) {
            throw new Error(`视频参考素材超过 128 MB 限制：${path.basename(filePath)}`);
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

async function uploadTemporaryReference(dataUri, label) {
    if (/^https?:\/\//i.test(String(dataUri || '').trim())) return String(dataUri).trim();

    const { mimeType, buffer } = decodeReferenceDataUri(dataUri);
    if (buffer.length === 0) throw new Error(`${label}内容为空`);
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const cached = temporaryReferenceUrlCache.get(contentHash);
    if (cached && cached.expiresAt > Date.now()) return cached.url;

    const extension = extensionForReferenceMimeType(mimeType);
    const fileName = `flow-canvas-${contentHash.slice(0, 16)}.${extension}`;
    const boundary = `----FlowCanvas${crypto.randomBytes(12).toString('hex')}`;
    const body = Buffer.concat([
        multipartField(boundary, 'reqtype', 'fileupload'),
        multipartField(boundary, 'time', '1h'),
        Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
            'utf8'
        ),
        buffer,
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ]);
    let lastFailure = '未知错误';
    for (let attempt = 1; attempt <= TEMP_REFERENCE_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45_000);
        let response;
        let responseText = '';
        let retryable = true;
        try {
            response = await net.fetch(TEMP_REFERENCE_UPLOAD_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    Accept: 'text/plain'
                },
                body,
                signal: controller.signal,
                redirect: 'follow'
            });
            responseText = (await response.text()).trim();
            if (response.ok && /^https?:\/\/\S+$/i.test(responseText)) {
                temporaryReferenceUrlCache.set(contentHash, {
                    url: responseText,
                    expiresAt: Date.now() + TEMP_REFERENCE_CACHE_TTL_MS
                });
                return responseText;
            }
            lastFailure = `HTTP ${response.status} ${responseText.slice(0, 300)}`.trim();
            retryable = [408, 425, 429].includes(response.status) || response.status >= 500 || response.ok;
        } catch (error) {
            lastFailure = error?.name === 'AbortError'
                ? '上传超时（45 秒）'
                : (error.message || String(error));
        } finally {
            clearTimeout(timeout);
        }

        if (!retryable || attempt === TEMP_REFERENCE_UPLOAD_MAX_ATTEMPTS) break;
        const retryAfterSeconds = Number(response?.headers?.get('retry-after'));
        const delay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? Math.min(10_000, retryAfterSeconds * 1000)
            : 800 * (2 ** (attempt - 1));
        console.warn(`[FlowCanvasBridge] ${label} temporary upload failed; retrying ${attempt + 1}/${TEMP_REFERENCE_UPLOAD_MAX_ATTEMPTS}:`, lastFailure);
        await sleep(delay);
    }

    throw new Error(`${label}临时上传失败（最多已尝试 ${TEMP_REFERENCE_UPLOAD_MAX_ATTEMPTS} 次）：${lastFailure}`);
}

async function uploadTemporaryReferences(entries, labelPrefix) {
    const urls = [];
    for (let index = 0; index < entries.length; index += 1) {
        urls.push(await uploadTemporaryReference(entries[index], `${labelPrefix} ${index + 1}`));
    }
    return urls;
}

function getVideoResultUrl(payload) {
    const first = Array.isArray(payload?.data) ? payload.data[0] : null;
    const candidates = [
        typeof first === 'string' ? first : first?.url,
        payload?.content?.video_url,
        payload?.video_url,
        payload?.result_url,
        payload?.url
    ];
    return candidates.find(value => typeof value === 'string' && value.trim()) || '';
}

function getVideoTaskId(payload) {
    const value = payload?.task_id || payload?.id || payload?.data?.task_id || payload?.data?.id;
    return value == null ? '' : String(value).trim();
}

function createVideoRecoveryId() {
    return `fc_${crypto.randomUUID().replace(/-/g, '')}`;
}

function isAmbiguousVideoSubmitError(error) {
    return /ERR_CONNECTION_(?:CLOSED|RESET)|ERR_TIMED_OUT|socket hang up|other side closed|fetch failed/i
        .test(error?.message || String(error));
}

function isMiniMaxH3Model(model) {
    return /minimax[^a-z0-9]*h3/i.test(String(model || ''));
}

function isCompletedVideoStatus(status) {
    return ['succeeded', 'completed', 'success'].includes(String(status || '').toLowerCase());
}

function isFailedVideoStatus(status) {
    return ['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(String(status || '').toLowerCase());
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollOpenAiVideoTask(generationEndpoint, apiKey, taskId, initialResponse, options = {}) {
    const directUrl = getVideoResultUrl(initialResponse);
    if (directUrl) return { payload: initialResponse, url: directUrl, taskId };
    if (!taskId) throw new Error('\u89c6\u9891\u63a5\u53e3\u8fd4\u56de\u4e2d\u6ca1\u6709\u4efb\u52a1 ID \u6216\u89c6\u9891\u5730\u5740');

    let currentTaskId = String(taskId);
    const buildTaskUrls = value => {
        const addModelQuery = endpoint => {
            if (!options.model) return endpoint;
            const url = new URL(endpoint);
            url.searchParams.set('model', options.model);
            return url.toString();
        };
        const genericTaskEndpoint = addModelQuery(buildOpenAiTaskEndpoint(generationEndpoint, value));
        const videoTaskEndpoint = addModelQuery(buildOpenAiVideoTaskEndpoint(generationEndpoint, value));
        const candidates = options.preferVideoTaskEndpoint
            ? [videoTaskEndpoint, genericTaskEndpoint]
            : [genericTaskEndpoint, videoTaskEndpoint];
        return candidates.filter((candidate, index, values) => values.indexOf(candidate) === index);
    };
    let taskUrls = buildTaskUrls(currentTaskId);
    let taskUrlIndex = 0;
    let recoveryNotFoundCount = 0;
    let consecutiveConnectionFailures = 0;
    const isRecoveringSubmission = initialResponse?.recovering === true;
    for (let attempt = 0; attempt < 720; attempt += 1) {
        if (attempt > 0) await sleep(5000);
        let taskUrl = taskUrls[taskUrlIndex];
        let response;
        let text;
        try {
            ({ response, text } = await fetchTextWithRetry(taskUrl, {
                method: 'GET',
                headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
                redirect: 'follow'
            }, '\u67e5\u8be2\u89c6\u9891\u4efb\u52a1\u72b6\u6001'));
            if ([404, 405].includes(response.status) && taskUrlIndex < taskUrls.length - 1) {
                taskUrlIndex += 1;
                taskUrl = taskUrls[taskUrlIndex];
                ({ response, text } = await fetchTextWithRetry(taskUrl, {
                    method: 'GET',
                    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
                    redirect: 'follow'
                }, '\u67e5\u8be2\u89c6\u9891\u4efb\u52a1\u72b6\u6001'));
            }
            consecutiveConnectionFailures = 0;
        } catch (error) {
            consecutiveConnectionFailures += 1;
            if (consecutiveConnectionFailures < 24) {
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
        if (!response.ok) {
            throw new Error(`\u67e5\u8be2\u89c6\u9891\u4efb\u52a1\u5931\u8d25\uff08${describeRemoteEndpoint(taskUrl)}\uff09\uff1a${response.status} ${text.slice(0, 1000)}`);
        }
        recoveryNotFoundCount = 0;
        let payload;
        try {
            payload = JSON.parse(text);
        } catch (_) {
            throw new Error('\u67e5\u8be2\u89c6\u9891\u4efb\u52a1\u65f6\uff0c\u670d\u52a1\u5668\u672a\u8fd4\u56de\u6709\u6548 JSON');
        }
        const resolvedTaskId = getVideoTaskId(payload);
        if (resolvedTaskId && resolvedTaskId !== currentTaskId) {
            currentTaskId = resolvedTaskId;
            taskUrls = buildTaskUrls(currentTaskId);
            taskUrlIndex = 0;
            options.onTaskIdResolved?.(currentTaskId, payload);
        }
        const url = getVideoResultUrl(payload);
        if (url && (isCompletedVideoStatus(payload?.status) || !payload?.status)) {
            return { payload, url, taskId: currentTaskId };
        }
        if (isFailedVideoStatus(payload?.status)) {
            const reason = payload?.error?.message || payload?.message || '\u670d\u52a1\u7aef\u672a\u63d0\u4f9b\u5931\u8d25\u539f\u56e0';
            throw new Error(`\u89c6\u9891\u751f\u6210\u4efb\u52a1\u5931\u8d25\uff1a${reason}`);
        }
    }
    throw new Error('\u89c6\u9891\u751f\u6210\u8d85\u65f6\uff1a\u7b49\u5f85 60 \u5206\u949f\u540e\u4ecd\u672a\u5b8c\u6210');
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

async function downloadVideo(url, targetDir, prompt) {
    let response;
    let buffer;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            response = await net.fetch(url, { method: 'GET', redirect: 'follow' });
        } catch (error) {
            lastError = error;
            if (attempt < 2) await sleep(750 * (attempt + 1));
            continue;
        }
        if (!response.ok) {
            throw new Error(`\u4e0b\u8f7d\u751f\u6210\u89c6\u9891\u5931\u8d25\uff08${describeRemoteEndpoint(url)}\uff09\uff1aHTTP ${response.status}`);
        }
        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > 512 * 1024 * 1024) {
            throw new Error('\u751f\u6210\u7684\u89c6\u9891\u8d85\u8fc7 512 MB \u4e0b\u8f7d\u9650\u5236');
        }
        try {
            buffer = Buffer.from(await response.arrayBuffer());
            break;
        } catch (error) {
            lastError = error;
            if (attempt < 2) await sleep(750 * (attempt + 1));
        }
    }
    if (!buffer) throw remoteConnectionError('\u4e0b\u8f7d\u751f\u6210\u89c6\u9891', url, lastError, 3);
    if (buffer.length === 0) throw new Error('\u670d\u52a1\u5668\u8fd4\u56de\u4e86\u7a7a\u89c6\u9891\u6587\u4ef6');
    const filePath = path.join(targetDir, uniqueVideoName('seedance', prompt, videoExtensionFromUrl(url, response.headers.get('content-type'))));
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

async function tryGenerateWithOpenAIVideo(prompt, targetDir, options = {}) {
    try {
        const providerConfig = options.providerConfig || {};
        const apiKey = String(providerConfig.apiKey || process.env.FLOW_CANVAS_VIDEO_API_KEY || '').trim();
        const endpoint = buildOpenAiVideoEndpoint(providerConfig.endpoint || process.env.FLOW_CANVAS_VIDEO_ENDPOINT);
        const model = String(providerConfig.model || options.model || process.env.FLOW_CANVAS_VIDEO_MODEL || 'doubao-seedance-2-0').trim();
        if (!apiKey) return { success: false, error: '\u672a\u914d\u7f6e\u89c6\u9891 API Key' };
        if (!endpoint) return { success: false, error: '\u672a\u914d\u7f6e\u89c6\u9891 API \u5730\u5740' };

        const isMiniMaxH3 = isMiniMaxH3Model(model);
        const body = { model, prompt };
        const resolution = String(options.resolution || '').trim();
        const ratio = String(options.ratio || '').trim();
        const duration = Number(options.duration);
        if (isMiniMaxH3) {
            if (prompt.length > 2000) {
                return { success: false, error: 'MiniMax H3 提示词不能超过 2000 个字符' };
            }
            if (Number.isInteger(duration) && (duration < 5 || duration > 15)) {
                return { success: false, error: 'MiniMax H3 视频时长必须在 5 到 15 秒之间' };
            }
            if (ratio && !['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].includes(ratio)) {
                return { success: false, error: `MiniMax H3 不支持画幅比例 ${ratio}` };
            }
            body.resolution = '2k';
            if (ratio) body.aspect_ratio = ratio;
            if (Number.isInteger(duration)) body.duration = duration;
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
        if (isMiniMaxH3 && videoReferences.length > 1) {
            return { success: false, error: 'MiniMax H3 最多支持 1 个参考视频' };
        }
        const images = await collectVideoReferenceImages(
            options.sourceReferences || [],
            options.compressReferenceImages === true,
            isMiniMaxH3 ? 5 : 9
        );
        const videos = collectVideoReferenceVideos(videoReferences);
        const audioUrls = collectVideoReferenceAudio(
            options.audioReferences || [],
            isMiniMaxH3 ? 1 : 3,
            isMiniMaxH3 ? 15 * 1024 * 1024 : 32 * 1024 * 1024
        );
        if (isMiniMaxH3) {
            if (audioUrls.length > 0 && images.length === 0) {
                return { success: false, error: 'MiniMax H3 使用参考音频时必须同时提供至少一张参考图片' };
            }
            const imageUrls = await uploadTemporaryReferences(
                images.map(image => image.url),
                '参考图片'
            );
            const referenceVideoUrls = await uploadTemporaryReferences(videos.slice(0, 1), '参考视频');
            const referenceAudioUrls = await uploadTemporaryReferences(audioUrls, '参考音频');
            if (imageUrls.length === 1) {
                body.first_image = imageUrls[0];
            } else if (imageUrls.length === 2) {
                body.first_image = imageUrls[0];
                body.last_image = imageUrls[1];
            } else if (imageUrls.length > 2) {
                body.reference_images = imageUrls;
            }
            if (referenceVideoUrls.length > 0) body.reference_videos = referenceVideoUrls;
            if (referenceAudioUrls.length > 0) body.reference_audios = referenceAudioUrls.slice(0, 1);
        } else {
            if (images.length > 0) body.images = images;
            if (videos.length > 0) body.videos = videos;
            if (audioUrls.length > 0) body.audio_urls = audioUrls;
        }

        const recoveryId = createVideoRecoveryId();
        let response;
        let text;
        let initialResponse;
        let recoveringSubmission = false;
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
                redirect: 'follow'
            });
            text = await response.text();
        } catch (error) {
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
            return {
                success: false,
                error: `\u63d0\u4ea4\u89c6\u9891\u751f\u6210\u4efb\u52a1\u5931\u8d25\uff08${describeRemoteEndpoint(endpoint)}\uff09\uff1aHTTP ${response.status} ${text.slice(0, 1000)}`
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
            preferVideoTaskEndpoint: isMiniMaxH3,
            onTaskIdResolved: (resolvedTaskId, payload) => options.onTaskSubmitted?.({
                taskId: resolvedTaskId,
                model,
                initialResponse: payload,
                recovered: recoveringSubmission
            })
        });
        const filePath = await downloadVideo(completed.url, targetDir, prompt);
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
    return `${prefix}_${hash}${IMAGE_EXTENSIONS.has(ext) ? ext : '.png'}`;
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
