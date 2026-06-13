const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const { app, net } = require('electron');
const { PlanService, DEFAULT_MCP_CONFIG } = require('../shared/plan-service-core.cjs');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
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
    'POST /images/generate': 'flow_canvas.image.generate'
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
    constructor({ store, getMainWindow, getDefaultSaveFolder, getFallbackSaveDir, notifyRenderer }) {
        this.store = store;
        this.getMainWindow = getMainWindow;
        this.getDefaultSaveFolder = getDefaultSaveFolder;
        this.getFallbackSaveDir = getFallbackSaveDir;
        this.notifyRenderer = notifyRenderer;
        this.server = null;
        this.host = DEFAULT_MCP_CONFIG.host;
        this.port = DEFAULT_MCP_CONFIG.port;
        this.allowedTools = new Set(DEFAULT_MCP_CONFIG.allowedTools);
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
            ['POST', /^\/images\/generate$/, ROUTE_TO_TOOL['POST /images/generate'], (_, body) => this._generateImage(body)]
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

    async generateImageFromRenderer(body) {
        const prompt = String(body?.prompt || '').trim();
        if (!prompt) throw new Error('Missing prompt');
        const { data, planService } = this._loadWithPlanService();
        const requestedTargetDir = body?.targetDir || this.getDefaultSaveFolder?.(data) || this.getFallbackSaveDir?.();
        if (!requestedTargetDir) throw new Error('No save directory available for generated image');
        const targetInfo = resolveWritableTargetDir(requestedTargetDir, this.getFallbackSaveDir?.());
        const targetDir = targetInfo.targetDir;

        const sourceContext = collectImageSourceReferences(data, planService, body);
        const generationOptions = {
            ...body,
            sourceReferences: sourceContext.references
        };

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

        const shouldAddToCanvas = result.provider !== 'builtin' || body.addToCanvas === true;
        const item = shouldAddToCanvas
            ? addBoardItem(data, result.filePath, {
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
                    ...((planService.getPlan(body.planId)?.rows || []).find(entry => entry.id === body.rowId)?.references || []),
                    generatedReference
                ]);
            const row = planService.updateRow(body.planId, body.rowId, {
                references
            });
            if (!row) {
                console.warn('[FlowCanvasBridge] generated image added, but row reference failed:', body.planId, body.rowId);
            }
        }

        this._saveAndNotify(data, 'mcp:image-generated');
        return {
            item,
            filePath: result.filePath,
            provider: result.provider,
            image: {
                width: result.width,
                height: result.height
            },
            sourceReferences: sourceContext.references,
            missingSourceReferences: sourceContext.missing,
            plan: body.planId ? planService.getPlan(body.planId) : null,
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
    return String(filePath || '').replace(/\//g, '\\').toLowerCase();
}

function buildOpenAiImageEndpoint(endpoint) {
    const raw = String(endpoint || '').trim() || 'https://api.openai.com/v1/images/generations';
    try {
        const url = new URL(raw);
        let pathName = url.pathname.replace(/\/+$/, '');
        if (!pathName || pathName === '/') {
            pathName = '/v1/images/generations';
        } else if (/\/v1$/i.test(pathName)) {
            pathName += '/images/generations';
        } else if (/\/(?:chat\/completions|responses|completions|models)$/i.test(pathName)) {
            pathName = pathName.replace(/\/(?:chat\/completions|responses|completions|models)$/i, '/images/generations');
        } else if (!/\/images\/generations$/i.test(pathName)) {
            pathName += '/images/generations';
        }
        url.pathname = pathName;
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch (_) {
        return raw;
    }
}

async function tryGenerateWithOpenAI(prompt, targetDir, options = {}) {
    try {
        const providerConfig = options.providerConfig || {};
        const apiKey = String(providerConfig.apiKey || process.env.OPENAI_API_KEY || '').trim();
        if (!apiKey) {
            return { success: false, error: 'OpenAI image API key is missing' };
        }

        const endpoint = buildOpenAiImageEndpoint(providerConfig.endpoint);
        const model = process.env.FLOW_CANVAS_IMAGE_MODEL || providerConfig.model || options.model || 'gpt-image-1';
        const size = options.size || '1024x1024';
        const res = await net.fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model,
                prompt,
                size,
                n: 1
            })
        });
        if (!res.ok) {
            const text = await res.text();
            return { success: false, error: `OpenAI image generation failed: ${res.status} ${text}` };
        }
        const json = await res.json();
        const image = json?.data?.[0];
        let buffer = null;
        if (image?.b64_json) {
            buffer = Buffer.from(image.b64_json, 'base64');
        } else if (image?.url) {
            const imageRes = await net.fetch(image.url);
            if (!imageRes.ok) throw new Error(`Image download failed: ${imageRes.status}`);
            buffer = Buffer.from(await imageRes.arrayBuffer());
        }
        if (!buffer) return { success: false, error: 'OpenAI response did not include image data' };
        const filePath = path.join(targetDir, uniqueImageName('ai', prompt, '.png'));
        fs.writeFileSync(filePath, buffer);
        const metadata = await sharp(buffer).metadata().catch(() => ({}));
        return {
            success: true,
            provider: 'openai',
            filePath,
            width: metadata.width || 1024,
            height: metadata.height || 1024
        };
    } catch (error) {
        return { success: false, error: error.message };
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
