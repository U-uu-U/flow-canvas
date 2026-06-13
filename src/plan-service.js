const PLAN_SCHEMA_VERSION = 1;
const DEFAULT_PLAN_NODE_WIDTH = 1440;
const DEFAULT_PLAN_NODE_HEIGHT = 620;

export const DEFAULT_PLAN_COLUMNS = [
    { key: 'stage', label: '序号/阶段', width: 92 },
    { key: 'title', label: '标题', width: 160 },
    { key: 'role', label: '目标/叙事角色', width: 180 },
    { key: 'content', label: '详细内容', width: 260 },
    { key: 'assets', label: '所需素材/引用', width: 220 },
    { key: 'output', label: '输出类型', width: 120 },
    { key: 'status', label: '状态', width: 110 },
    { key: 'notes', label: '备注/风格约束', width: 220 }
];

export const DEFAULT_PLAN_STATUSES = ['未开始', '进行中', '待确认', '已完成'];

export const DEFAULT_MCP_CONFIG = {
    enabled: true,
    host: '127.0.0.1',
    port: 18765,
    allowedTools: [
        'flow_canvas.health',
        'flow_canvas.config.get',
        'flow_canvas.config.update',
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
        'flow_canvas.item.list',
        'flow_canvas.item.get',
        'flow_canvas.item.add',
        'flow_canvas.item.update',
        'flow_canvas.item.delete'
    ]
};

export class PlanService {
    constructor(storeData) {
        this.storeData = storeData;
        this.migrateStoreData();
    }

    migrateStoreData() {
        if (!this.storeData) return;
        if (!Array.isArray(this.storeData.folderGroups)) {
            this.storeData.folderGroups = [];
        }

        this.storeData.mcp = {
            ...DEFAULT_MCP_CONFIG,
            ...(this.storeData.mcp || {}),
            allowedTools: Array.isArray(this.storeData.mcp?.allowedTools)
                ? this.storeData.mcp.allowedTools
                : [...DEFAULT_MCP_CONFIG.allowedTools]
        };
        const configuredPort = Number(this.storeData.mcp.port);
        if (!Number.isInteger(configuredPort) || configuredPort < 1024 || configuredPort > 65535 || configuredPort === 8765) {
            this.storeData.mcp.port = DEFAULT_MCP_CONFIG.port;
        }
        this.storeData.mcp.host = '127.0.0.1';

        this.storeData.folderGroups.forEach(group => this.ensureGroup(group));
    }

    ensureGroup(group) {
        if (!group) return null;
        if (!Array.isArray(group.plans)) group.plans = [];
        group.plans = group.plans.map(plan => this.normalizePlan(plan));
        return group;
    }

    getActiveGroup() {
        const groups = this.storeData?.folderGroups || [];
        const group = groups.find(entry => entry.id === this.storeData.activeGroupId) || null;
        return this.ensureGroup(group);
    }

    getActivePlans() {
        const group = this.getActiveGroup();
        return group ? group.plans : [];
    }

    listPlans() {
        return this.getActivePlans();
    }

    getPlan(planId) {
        return this.getActivePlans().find(plan => plan.id === planId) || null;
    }

    createPlan({ title = '规划矩阵', node = {} } = {}) {
        const group = this.getActiveGroup();
        if (!group) return null;

        const now = Date.now();
        const plan = this.normalizePlan({
            id: this._makeId('plan'),
            title: this._uniqueTitle(title, group.plans),
            schemaVersion: PLAN_SCHEMA_VERSION,
            columns: clone(DEFAULT_PLAN_COLUMNS),
            rows: this._createDefaultRows(),
            node: {
                x: Number.isFinite(node.x) ? node.x : 0,
                y: Number.isFinite(node.y) ? node.y : 0,
                width: Number.isFinite(node.width) ? node.width : DEFAULT_PLAN_NODE_WIDTH,
                height: Number.isFinite(node.height) ? node.height : DEFAULT_PLAN_NODE_HEIGHT
            },
            createdAt: now,
            updatedAt: now
        });

        group.plans.push(plan);
        return plan;
    }

    updatePlan(planId, patch = {}) {
        const plan = this.getPlan(planId);
        if (!plan) return null;

        if (typeof patch.title === 'string') {
            plan.title = patch.title.trim() || plan.title;
        }
        if (Array.isArray(patch.rows)) {
            plan.rows = patch.rows.map(row => this.normalizeRow(row));
        }
        if (Array.isArray(patch.columns)) {
            plan.columns = this.normalizeColumns(patch.columns);
        }
        if (patch.node) {
            plan.node = this.normalizeNode({ ...plan.node, ...patch.node });
        }
        plan.updatedAt = Date.now();
        return plan;
    }

    updatePlanNode(planId, nodePatch = {}) {
        const plan = this.getPlan(planId);
        if (!plan) return null;
        plan.node = this.normalizeNode({ ...plan.node, ...nodePatch });
        plan.updatedAt = Date.now();
        return plan;
    }

    deletePlan(planId) {
        const group = this.getActiveGroup();
        if (!group) return false;
        const before = group.plans.length;
        group.plans = group.plans.filter(plan => plan.id !== planId);
        return group.plans.length !== before;
    }

    createRow(index = 0, patch = {}) {
        const rowNumber = Number.isFinite(index) ? index + 1 : '';
        return this.normalizeRow({
            id: patch.id || this._makeId('row'),
            cells: {
                stage: String(rowNumber),
                status: '未开始',
                ...(patch.cells || {})
            },
            references: patch.references || []
        });
    }

    getAgentContext(selectedFiles = []) {
        const group = this.getActiveGroup();
        const plans = this.getActivePlans().map(plan => ({
            id: plan.id,
            title: plan.title,
            rowCount: plan.rows.length,
            columns: plan.columns.map(column => ({ key: column.key, label: column.label })),
            rows: plan.rows.map(row => ({
                id: row.id,
                cells: { ...row.cells },
                references: [...(row.references || [])]
            }))
        }));

        return {
            schema: 'flow-canvas.agent-planning-context.v1',
            activeGroup: group ? {
                id: group.id,
                name: group.name,
                folders: [...(group.folders || [])],
                defaultSaveFolder: group.defaultSaveFolder || null
            } : null,
            plans,
            selectedFiles: selectedFiles.map((filePath, index) => ({
                index: index + 1,
                path: filePath,
                name: String(filePath || '').split(/[/\\]/).pop() || filePath
            }))
        };
    }

    normalizePlan(plan = {}) {
        const now = Date.now();
        const columns = this.normalizeColumns(plan.columns);
        let rows = Array.isArray(plan.rows) ? plan.rows.map(row => this.normalizeRow(row)) : [];
        if (rows.length === 0) rows = this._createDefaultRows();

        return {
            id: plan.id || this._makeId('plan'),
            title: String(plan.title || '规划矩阵'),
            schemaVersion: PLAN_SCHEMA_VERSION,
            columns,
            rows,
            node: this.normalizeNode(plan.node || plan),
            createdAt: Number.isFinite(plan.createdAt) ? plan.createdAt : now,
            updatedAt: Number.isFinite(plan.updatedAt) ? plan.updatedAt : now
        };
    }

    normalizeColumns(columns) {
        const source = Array.isArray(columns) && columns.length > 0 ? columns : DEFAULT_PLAN_COLUMNS;
        return source.map((column, index) => {
            const fallback = DEFAULT_PLAN_COLUMNS[index] || DEFAULT_PLAN_COLUMNS[0];
            return {
                key: String(column.key || fallback.key),
                label: String(column.label || fallback.label),
                width: Number.isFinite(column.width) ? column.width : fallback.width
            };
        });
    }

    normalizeRow(row = {}) {
        const cells = { ...(row.cells || {}) };
        const references = Array.isArray(row.references)
            ? row.references
                .map(reference => ({
                    itemId: reference.itemId ? String(reference.itemId) : '',
                    filePath: String(reference.filePath || ''),
                    name: String(reference.name || '').trim(),
                    kind: this.normalizeReferenceKind(reference)
                }))
                .filter(reference => reference.filePath)
            : [];
        DEFAULT_PLAN_COLUMNS.forEach(column => {
            if (cells[column.key] == null) cells[column.key] = '';
            cells[column.key] = String(cells[column.key]);
        });
        if (!cells.status) cells.status = '未开始';

        return {
            id: row.id || this._makeId('row'),
            cells,
            references
        };
    }

    normalizeReferenceKind(reference = {}) {
        if (reference.kind === 'output' || reference.role === 'output' || reference.generated === true) return 'output';
        if (reference.kind === 'process' || reference.role === 'process') return 'process';
        const name = String(reference.filePath || reference.name || '').split(/[/\\]/).pop().toLowerCase();
        if (name.startsWith('flow_source_builtin_') || name.startsWith('flow_builtin_')) return 'process';
        if (name.startsWith('flow_imagegen_') || name.startsWith('ai_')) return 'output';
        return 'source';
    }

    normalizeNode(node = {}) {
        const width = Number.isFinite(node.width) ? node.width : DEFAULT_PLAN_NODE_WIDTH;
        const height = Number.isFinite(node.height) ? node.height : DEFAULT_PLAN_NODE_HEIGHT;
        return {
            x: Number.isFinite(node.x) ? node.x : 0,
            y: Number.isFinite(node.y) ? node.y : 0,
            width: width < 900 ? DEFAULT_PLAN_NODE_WIDTH : width,
            height: height < 500 ? DEFAULT_PLAN_NODE_HEIGHT : height
        };
    }

    _createDefaultRows() {
        return [0, 1, 2].map(index => this.createRow(index));
    }

    _uniqueTitle(baseTitle, plans) {
        const normalizedBase = String(baseTitle || '规划矩阵').trim() || '规划矩阵';
        const existing = new Set((plans || []).map(plan => plan.title));
        if (!existing.has(normalizedBase)) return normalizedBase;
        let index = 2;
        while (existing.has(`${normalizedBase} ${index}`)) index += 1;
        return `${normalizedBase} ${index}`;
    }

    _makeId(prefix) {
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}
