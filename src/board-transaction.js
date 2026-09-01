import { NODE_TYPES } from './node-types.js';
import { canConnect, getPorts, portsCompatible } from './graph-model.js';

export const BOARD_SNAPSHOT_SCHEMA = 'flow-canvas.board-snapshot.v1';
export const BOARD_TRANSACTION_SCHEMA = 'flow-canvas.board-transaction.v1';

const MAX_OPERATIONS = 500;
const MAX_APPLIED_KEYS = 200;
const MUTABLE_NODE_FIELDS = new Set([
    'title', 'x', 'y', 'width', 'height', 'config', 'model', 'tags', 'metadata'
]);

const OPERATION_NAMES = new Set([
    'node.create',
    'node.update',
    'node.delete',
    'node.duplicate',
    'connection.create',
    'connection.delete',
    'layout.arrange'
]);

export class BoardTransactionError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'BoardTransactionError';
        this.code = code;
        this.details = details;
    }
}

export function createBoardSnapshot(state = {}, options = {}) {
    const allItems = clone(Array.isArray(state.items) ? state.items : []);
    const allConnections = clone(Array.isArray(state.connections) ? state.connections : []);
    const scope = String(options.scope || 'project');
    const selectedIds = new Set((options.selectedItemIds || state.selectedItemIds || []).map(String));
    const includedIds = resolveSnapshotIds(allItems, allConnections, scope, selectedIds, options);
    const items = scope === 'project' || scope === 'full'
        ? allItems
        : allItems.filter(item => includedIds.has(String(item.id)));
    const itemIds = new Set(items.map(item => String(item.id)));
    const connections = allConnections.filter(connection =>
        itemIds.has(String(connection?.from?.nodeId))
        && itemIds.has(String(connection?.to?.nodeId))
    );

    return {
        schema: BOARD_SNAPSHOT_SCHEMA,
        projectId: state.projectId || state.activeGroupId || null,
        revision: normalizeRevision(state.revision ?? state.boardRevision),
        scope,
        items,
        connections,
        plans: clone(Array.isArray(state.plans) ? state.plans : []),
        viewport: normalizeViewport(state.viewport),
        selectedItemIds: [...selectedIds].filter(id => itemIds.has(id)),
        appliedTransactionKeys: normalizeAppliedKeys(state.appliedTransactionKeys),
        capturedAt: Number(options.capturedAt) || Date.now()
    };
}

export function normalizeBoardTransaction(transaction = {}) {
    if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
        throw new BoardTransactionError('INVALID_TRANSACTION', '事务必须是对象');
    }
    const id = String(transaction.id || '').trim();
    if (!id) throw new BoardTransactionError('INVALID_TRANSACTION', '事务缺少 id');
    if (!Number.isInteger(Number(transaction.baseRevision)) || Number(transaction.baseRevision) < 0) {
        throw new BoardTransactionError('INVALID_TRANSACTION', '事务缺少有效的 baseRevision');
    }
    if (!Array.isArray(transaction.operations) || transaction.operations.length === 0) {
        throw new BoardTransactionError('INVALID_TRANSACTION', '事务至少需要一个操作');
    }
    if (transaction.operations.length > MAX_OPERATIONS) {
        throw new BoardTransactionError('TOO_MANY_OPERATIONS', `单次事务最多允许 ${MAX_OPERATIONS} 个操作`);
    }

    const operations = transaction.operations.map((operation, index) => {
        if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
            throw new BoardTransactionError('INVALID_OPERATION', `第 ${index + 1} 个操作不是对象`, { operationIndex: index });
        }
        const op = String(operation.op || '').trim();
        if (!OPERATION_NAMES.has(op)) {
            throw new BoardTransactionError('UNSUPPORTED_OPERATION', `不支持的画板操作：${op || '(empty)'}`, {
                operationIndex: index,
                op
            });
        }
        return clone({ ...operation, op });
    });

    return {
        schema: BOARD_TRANSACTION_SCHEMA,
        id,
        baseRevision: Number(transaction.baseRevision),
        projectId: transaction.projectId || null,
        idempotencyKey: String(transaction.idempotencyKey || id),
        reason: String(transaction.reason || '').trim(),
        operations
    };
}

export function previewBoardTransaction(snapshot, transaction, options = {}) {
    const current = normalizeSnapshot(snapshot);
    const normalized = normalizeBoardTransaction(transaction);
    validateTransactionTarget(current, normalized);

    if (current.appliedTransactionKeys.includes(normalized.idempotencyKey)) {
        return {
            ok: true,
            duplicate: true,
            transaction: normalized,
            currentRevision: current.revision,
            nextRevision: current.revision,
            operations: [],
            summary: emptySummary(),
            warnings: ['该事务已经提交，本次不会重复执行']
        };
    }

    const simulation = simulate(current, normalized, options);
    return {
        ok: true,
        duplicate: false,
        transaction: normalized,
        currentRevision: current.revision,
        nextRevision: current.revision + 1,
        operations: simulation.operationResults,
        summary: simulation.summary,
        warnings: simulation.warnings,
        tempIds: Object.fromEntries(simulation.tempIds)
    };
}

export function applyBoardTransaction(snapshot, transaction, options = {}) {
    const current = normalizeSnapshot(snapshot);
    const normalized = normalizeBoardTransaction(transaction);
    validateTransactionTarget(current, normalized);

    if (current.appliedTransactionKeys.includes(normalized.idempotencyKey)) {
        return {
            ok: true,
            duplicate: true,
            transaction: normalized,
            snapshot: current,
            currentRevision: current.revision,
            nextRevision: current.revision,
            operations: [],
            summary: emptySummary(),
            warnings: ['该事务已经提交，本次不会重复执行'],
            tempIds: {},
            undoToken: null,
            undoRecord: null
        };
    }

    const simulation = simulate(current, normalized, options);
    const next = simulation.snapshot;
    next.revision = current.revision + 1;
    next.capturedAt = Date.now();
    next.appliedTransactionKeys = [
        ...current.appliedTransactionKeys.filter(key => key !== normalized.idempotencyKey),
        normalized.idempotencyKey
    ].slice(-MAX_APPLIED_KEYS);
    const undoToken = stableId('undo', normalized.id, next.revision);
    const undoRecord = {
        schema: 'flow-canvas.board-undo-record.v1',
        token: undoToken,
        transactionId: normalized.id,
        projectId: current.projectId,
        beforeRevision: current.revision,
        afterRevision: next.revision,
        beforeSnapshot: current
    };

    return {
        ok: true,
        duplicate: false,
        transaction: normalized,
        snapshot: next,
        currentRevision: current.revision,
        nextRevision: next.revision,
        operations: simulation.operationResults,
        summary: simulation.summary,
        warnings: simulation.warnings,
        tempIds: Object.fromEntries(simulation.tempIds),
        undoToken,
        undoRecord
    };
}

export function undoBoardTransaction(snapshot, undoRecord) {
    const current = normalizeSnapshot(snapshot);
    if (!undoRecord || undoRecord.schema !== 'flow-canvas.board-undo-record.v1') {
        throw new BoardTransactionError('INVALID_UNDO_TOKEN', '撤销令牌无效');
    }
    if (undoRecord.projectId && current.projectId && undoRecord.projectId !== current.projectId) {
        throw new BoardTransactionError('PROJECT_MISMATCH', '撤销令牌不属于当前项目');
    }
    if (current.revision !== Number(undoRecord.afterRevision)) {
        throw new BoardTransactionError(
            'REVISION_CONFLICT',
            `画板已从 revision ${undoRecord.afterRevision} 变更为 ${current.revision}，不能直接撤销该事务`,
            { expectedRevision: Number(undoRecord.afterRevision), actualRevision: current.revision }
        );
    }

    const restored = normalizeSnapshot(undoRecord.beforeSnapshot);
    restored.revision = current.revision + 1;
    restored.capturedAt = Date.now();
    restored.appliedTransactionKeys = [...current.appliedTransactionKeys];
    return {
        ok: true,
        transactionId: undoRecord.transactionId,
        undoToken: undoRecord.token,
        previousRevision: current.revision,
        nextRevision: restored.revision,
        snapshot: restored
    };
}

function simulate(current, transaction, options) {
    const next = clone(current);
    const operationResults = [];
    const warnings = [];
    const tempIds = new Map();
    const summary = emptySummary();

    transaction.operations.forEach((operation, operationIndex) => {
        try {
            const result = applyOperation(next, transaction, operation, operationIndex, tempIds, options, warnings);
            operationResults.push({ index: operationIndex, op: operation.op, ...result });
            incrementSummary(summary, operation.op, result);
        } catch (error) {
            if (error instanceof BoardTransactionError) {
                error.details = { ...error.details, operationIndex, op: operation.op };
                throw error;
            }
            throw new BoardTransactionError('OPERATION_FAILED', error?.message || String(error), {
                operationIndex,
                op: operation.op
            });
        }
    });

    return { snapshot: next, operationResults, warnings, tempIds, summary };
}

function applyOperation(snapshot, transaction, operation, operationIndex, tempIds, options, warnings) {
    switch (operation.op) {
        case 'node.create':
            return createNode(snapshot, transaction, operation, operationIndex, tempIds, options);
        case 'node.update':
            return updateNode(snapshot, operation, tempIds);
        case 'node.delete':
            return deleteNode(snapshot, operation, tempIds);
        case 'node.duplicate':
            return duplicateNode(snapshot, transaction, operation, operationIndex, tempIds);
        case 'connection.create':
            return createConnection(snapshot, transaction, operation, operationIndex, tempIds, warnings);
        case 'connection.delete':
            return deleteConnection(snapshot, operation, tempIds);
        case 'layout.arrange':
            return arrangeNodes(snapshot, operation, tempIds);
        default:
            throw new BoardTransactionError('UNSUPPORTED_OPERATION', `不支持的画板操作：${operation.op}`);
    }
}

function createNode(snapshot, transaction, operation, operationIndex, tempIds, options) {
    const requestedTempId = String(operation.tempId || '').trim();
    if (requestedTempId && tempIds.has(requestedTempId)) {
        throw new BoardTransactionError('DUPLICATE_TEMP_ID', `临时节点 ID 重复：${requestedTempId}`);
    }
    const generatedId = String(operation.id || operation.item?.id || stableId('node', transaction.id, operationIndex));
    if (findItem(snapshot, generatedId)) {
        throw new BoardTransactionError('NODE_EXISTS', `节点已存在：${generatedId}`);
    }

    const input = clone(operation.item || operation.data || {});
    const nodeType = String(operation.nodeType || input.nodeType || '').trim();
    let item;
    if (typeof options.createNode === 'function') {
        item = options.createNode({ ...operation, id: generatedId, nodeType }, {
            transaction,
            operationIndex,
            snapshot: clone(snapshot)
        });
    } else {
        item = buildDefaultNode(generatedId, nodeType, input, operation.position);
    }
    if (!item || typeof item !== 'object') {
        throw new BoardTransactionError('INVALID_NODE', '节点创建器没有返回有效节点');
    }
    item = clone(item);
    item.id = generatedId;
    validateNode(item);
    snapshot.items.push(item);
    if (requestedTempId) tempIds.set(requestedTempId, generatedId);
    return { status: 'ready', nodeId: generatedId, tempId: requestedTempId || null };
}

function updateNode(snapshot, operation, tempIds) {
    const nodeId = resolveNodeId(operation.nodeId || operation.id, tempIds);
    const item = requireItem(snapshot, nodeId);
    const patch = operation.patch && typeof operation.patch === 'object' ? operation.patch : {};
    const nextPatch = {};
    Object.entries(patch).forEach(([key, value]) => {
        if (!MUTABLE_NODE_FIELDS.has(key)) {
            throw new BoardTransactionError('IMMUTABLE_NODE_FIELD', `不允许修改节点字段：${key}`);
        }
        if (key === 'config') {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new BoardTransactionError('INVALID_NODE_PATCH', 'config 必须是对象');
            }
            nextPatch.config = { ...(item.config || {}), ...clone(value) };
            return;
        }
        if (['x', 'y', 'width', 'height'].includes(key)) {
            const number = Number(value);
            if (!Number.isFinite(number)) {
                throw new BoardTransactionError('INVALID_NODE_PATCH', `${key} 必须是有限数字`);
            }
            nextPatch[key] = number;
            return;
        }
        nextPatch[key] = clone(value);
    });
    Object.assign(item, nextPatch);
    return { status: 'ready', nodeId, fields: Object.keys(nextPatch) };
}

function deleteNode(snapshot, operation, tempIds) {
    const nodeId = resolveNodeId(operation.nodeId || operation.id, tempIds);
    const item = requireItem(snapshot, nodeId);
    snapshot.items = snapshot.items.filter(entry => String(entry.id) !== nodeId);
    const beforeConnections = snapshot.connections.length;
    snapshot.connections = snapshot.connections.filter(connection =>
        String(connection?.from?.nodeId) !== nodeId && String(connection?.to?.nodeId) !== nodeId
    );
    removePlanReferences(snapshot.plans, item);
    return {
        status: 'ready',
        nodeId,
        removedConnections: beforeConnections - snapshot.connections.length
    };
}

function duplicateNode(snapshot, transaction, operation, operationIndex, tempIds) {
    const sourceId = resolveNodeId(operation.nodeId || operation.sourceId, tempIds);
    const source = requireItem(snapshot, sourceId);
    const nodeId = String(operation.id || stableId('node', transaction.id, operationIndex));
    if (findItem(snapshot, nodeId)) throw new BoardTransactionError('NODE_EXISTS', `节点已存在：${nodeId}`);
    const offset = operation.offset && typeof operation.offset === 'object' ? operation.offset : {};
    const item = clone(source);
    item.id = nodeId;
    item.x = (Number(source.x) || 0) + (Number(offset.x) || 30);
    item.y = (Number(source.y) || 0) + (Number(offset.y) || 30);
    delete item.runResult;
    item.runStatus = 'idle';
    item.runError = '';
    const requestedTempId = String(operation.tempId || '').trim();
    if (requestedTempId) {
        if (tempIds.has(requestedTempId)) {
            throw new BoardTransactionError('DUPLICATE_TEMP_ID', `临时节点 ID 重复：${requestedTempId}`);
        }
        tempIds.set(requestedTempId, nodeId);
    }
    snapshot.items.push(item);
    return { status: 'ready', nodeId, sourceId, tempId: requestedTempId || null };
}

function createConnection(snapshot, transaction, operation, operationIndex, tempIds, warnings) {
    const from = normalizeEndpoint(operation.from, tempIds, 'from');
    const to = normalizeEndpoint(operation.to, tempIds, 'to');
    const fromItem = requireItem(snapshot, from.nodeId);
    const toItem = requireItem(snapshot, to.nodeId);
    from.port = from.port || getPorts(fromItem).outputs[0]?.name || '';
    to.port = to.port || chooseInputPort(fromItem, from.port, toItem);
    if (!from.port || !to.port) {
        throw new BoardTransactionError('INVALID_CONNECTION', '无法推断连线端口，请显式提供 from.port 和 to.port');
    }

    const result = operation.kind === 'history'
        ? canConnectHistory(fromItem, from.port, toItem, to.port, snapshot.connections)
        : canConnect(fromItem, from.port, toItem, to.port, snapshot.connections);
    if (!result.ok) throw new BoardTransactionError('INVALID_CONNECTION', result.reason || '连线无效');
    if (result.replaces) {
        snapshot.connections = snapshot.connections.filter(connection => connection.id !== result.replaces.id);
        warnings.push(`输入端口 ${to.nodeId}.${to.port} 原有连线将被替换`);
    }
    const connectionId = String(operation.id || stableId('connection', transaction.id, operationIndex));
    if (snapshot.connections.some(connection => String(connection.id) === connectionId)) {
        throw new BoardTransactionError('CONNECTION_EXISTS', `连线已存在：${connectionId}`);
    }
    const connection = { id: connectionId, from, to };
    if (operation.kind && operation.kind !== 'flow') connection.kind = String(operation.kind);
    snapshot.connections.push(connection);
    return { status: 'ready', connectionId, from, to, replacedConnectionId: result.replaces?.id || null };
}

function deleteConnection(snapshot, operation, tempIds) {
    let connection = null;
    const connectionId = String(operation.connectionId || operation.id || '').trim();
    if (connectionId) {
        connection = snapshot.connections.find(entry => String(entry.id) === connectionId) || null;
    } else if (operation.from && operation.to) {
        const from = normalizeEndpoint(operation.from, tempIds, 'from');
        const to = normalizeEndpoint(operation.to, tempIds, 'to');
        connection = snapshot.connections.find(entry =>
            String(entry?.from?.nodeId) === from.nodeId
            && (!from.port || entry?.from?.port === from.port)
            && String(entry?.to?.nodeId) === to.nodeId
            && (!to.port || entry?.to?.port === to.port)
        ) || null;
    }
    if (!connection) throw new BoardTransactionError('CONNECTION_NOT_FOUND', '找不到要删除的连线');
    snapshot.connections = snapshot.connections.filter(entry => entry !== connection);
    return { status: 'ready', connectionId: connection.id };
}

function arrangeNodes(snapshot, operation, tempIds) {
    const nodeIds = (Array.isArray(operation.nodeIds) ? operation.nodeIds : [])
        .map(id => resolveNodeId(id, tempIds));
    if (nodeIds.length === 0) throw new BoardTransactionError('INVALID_LAYOUT', '排列操作缺少 nodeIds');
    if (new Set(nodeIds).size !== nodeIds.length) {
        throw new BoardTransactionError('INVALID_LAYOUT', '排列操作包含重复节点');
    }
    const items = nodeIds.map(id => requireItem(snapshot, id));
    const mode = String(operation.mode || 'horizontal');
    if (!['horizontal', 'vertical', 'grid'].includes(mode)) {
        throw new BoardTransactionError('INVALID_LAYOUT', `不支持的排列模式：${mode}`);
    }
    const gap = clampNumber(operation.gap, 0, 1000, 48);
    const columns = Math.max(1, Math.min(50, Math.floor(Number(operation.columns) || Math.ceil(Math.sqrt(items.length)))));
    const origin = {
        x: finiteOr(operation.origin?.x, Math.min(...items.map(item => Number(item.x) || 0))),
        y: finiteOr(operation.origin?.y, Math.min(...items.map(item => Number(item.y) || 0)))
    };

    const columnWidths = Array.from({ length: columns }, (_, column) =>
        Math.max(...items.filter((_, index) => index % columns === column)
            .map(item => Math.max(1, Number(item.width) || 320)), 1)
    );
    const rowCount = Math.ceil(items.length / columns);
    const rowHeights = Array.from({ length: rowCount }, (_, row) =>
        Math.max(...items.slice(row * columns, (row + 1) * columns)
            .map(item => Math.max(1, Number(item.height) || 240)), 1)
    );
    const columnOffsets = columnWidths.map((_, column) =>
        columnWidths.slice(0, column).reduce((total, width) => total + width + gap, 0)
    );
    const rowOffsets = rowHeights.map((_, row) =>
        rowHeights.slice(0, row).reduce((total, height) => total + height + gap, 0)
    );
    let cursorX = origin.x;
    let cursorY = origin.y;
    items.forEach((item, index) => {
        const width = Math.max(1, Number(item.width) || 320);
        const height = Math.max(1, Number(item.height) || 240);
        if (mode === 'horizontal') {
            item.x = cursorX;
            item.y = origin.y;
            cursorX += width + gap;
            return;
        }
        if (mode === 'vertical') {
            item.x = origin.x;
            item.y = cursorY;
            cursorY += height + gap;
            return;
        }

        const column = index % columns;
        const row = Math.floor(index / columns);
        item.x = origin.x + columnOffsets[column];
        item.y = origin.y + rowOffsets[row];
    });
    return { status: 'ready', nodeIds, mode };
}

function buildDefaultNode(id, nodeType, input, position) {
    const kind = String(input.kind || (nodeType ? 'op' : '')).trim();
    if (kind === 'media') {
        return {
            ...input,
            id,
            kind: 'media',
            x: finiteOr(position?.x ?? input.x, 0),
            y: finiteOr(position?.y ?? input.y, 0)
        };
    }
    const definition = NODE_TYPES[nodeType];
    if (!definition) throw new BoardTransactionError('UNKNOWN_NODE_TYPE', `未知节点类型：${nodeType || '(empty)'}`);
    const defaults = Object.fromEntries((definition.config || []).map(field => [field.key, clone(field.default)]));
    return {
        ...input,
        id,
        kind: 'op',
        nodeType,
        title: String(input.title || (nodeType === 'image' ? '图片生成' : nodeType === 'video' ? '视频生成' : definition.title)),
        config: { ...defaults, ...(input.config || {}) },
        x: finiteOr(position?.x ?? input.x, 0),
        y: finiteOr(position?.y ?? input.y, 0),
        width: finiteOr(input.width, Number(definition.width) || 320),
        height: finiteOr(input.height, nodeType === 'text' ? 220 : 320),
        model: String(input.model || input.config?.model || ''),
        runStatus: 'idle',
        runError: ''
    };
}

function validateNode(item) {
    if (!String(item.id || '').trim()) throw new BoardTransactionError('INVALID_NODE', '节点缺少 id');
    if (item.kind === 'op') {
        if (!NODE_TYPES[item.nodeType]) {
            throw new BoardTransactionError('UNKNOWN_NODE_TYPE', `未知节点类型：${item.nodeType || '(empty)'}`);
        }
        if (!item.config || typeof item.config !== 'object' || Array.isArray(item.config)) {
            throw new BoardTransactionError('INVALID_NODE', '操作节点缺少 config 对象');
        }
        return;
    }
    if (item.kind === 'media' || item.filePath || item.mediaType) return;
    throw new BoardTransactionError('INVALID_NODE', '节点必须是 op 或 media');
}

function validateTransactionTarget(snapshot, transaction) {
    if (transaction.projectId && snapshot.projectId && transaction.projectId !== snapshot.projectId) {
        throw new BoardTransactionError('PROJECT_MISMATCH', '事务目标项目与当前项目不一致', {
            expectedProjectId: transaction.projectId,
            actualProjectId: snapshot.projectId
        });
    }
    if (transaction.baseRevision !== snapshot.revision) {
        throw new BoardTransactionError(
            'REVISION_CONFLICT',
            `画板 revision 已从 ${transaction.baseRevision} 变更为 ${snapshot.revision}，请重新读取后再执行`,
            { expectedRevision: transaction.baseRevision, actualRevision: snapshot.revision }
        );
    }
}

function normalizeSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
        throw new BoardTransactionError('INVALID_SNAPSHOT', '画板快照无效');
    }
    return createBoardSnapshot({
        ...snapshot,
        revision: snapshot.revision,
        projectId: snapshot.projectId,
        appliedTransactionKeys: snapshot.appliedTransactionKeys
    }, {
        scope: 'project',
        capturedAt: snapshot.capturedAt
    });
}

function resolveSnapshotIds(items, connections, scope, selectedIds, options) {
    if (scope === 'project' || scope === 'full') return new Set(items.map(item => String(item.id)));
    if (scope === 'selection') return selectedIds;
    if (scope === 'neighborhood') {
        const result = new Set(selectedIds);
        let frontier = new Set(selectedIds);
        const depth = Math.max(1, Math.min(10, Number(options.depth) || 1));
        for (let index = 0; index < depth; index += 1) {
            const next = new Set();
            connections.forEach(connection => {
                const from = String(connection?.from?.nodeId || '');
                const to = String(connection?.to?.nodeId || '');
                if (frontier.has(from) && !result.has(to)) next.add(to);
                if (frontier.has(to) && !result.has(from)) next.add(from);
            });
            next.forEach(id => result.add(id));
            frontier = next;
        }
        return result;
    }
    if (scope === 'viewport') {
        const bounds = options.viewportBounds || {};
        const left = finiteOr(bounds.x, -Number.MAX_SAFE_INTEGER);
        const top = finiteOr(bounds.y, -Number.MAX_SAFE_INTEGER);
        const right = Number.isFinite(Number(bounds.width))
            ? left + Math.max(0, Number(bounds.width))
            : Number.MAX_SAFE_INTEGER;
        const bottom = Number.isFinite(Number(bounds.height))
            ? top + Math.max(0, Number(bounds.height))
            : Number.MAX_SAFE_INTEGER;
        return new Set(items.filter(item => {
            const x = Number(item.x) || 0;
            const y = Number(item.y) || 0;
            const width = Math.max(1, Number(item.width) || 320);
            const height = Math.max(1, Number(item.height) || 240);
            return x + width >= left && x <= right && y + height >= top && y <= bottom;
        }).map(item => String(item.id)));
    }
    throw new BoardTransactionError('INVALID_SNAPSHOT_SCOPE', `不支持的快照范围：${scope}`);
}

function normalizeEndpoint(endpoint, tempIds, name) {
    if (!endpoint || typeof endpoint !== 'object') {
        throw new BoardTransactionError('INVALID_CONNECTION', `${name} 必须是对象`);
    }
    return {
        nodeId: resolveNodeId(endpoint.nodeId || endpoint.id, tempIds),
        port: String(endpoint.port || '').trim()
    };
}

function chooseInputPort(fromItem, fromPort, toItem) {
    const output = getPorts(fromItem).outputs.find(port => port.name === fromPort);
    if (!output) return '';
    return getPorts(toItem).inputs.find(input => {
        if (Array.isArray(input.accepts) && input.accepts.length > 0) {
            return output.dataType === 'any' || input.accepts.includes(output.dataType);
        }
        return output.dataType === 'any' || input.dataType === 'any' || output.dataType === input.dataType;
    })?.name || '';
}

function canConnectHistory(fromItem, fromPort, toItem, toPort, connections) {
    if (!fromItem || !toItem) return { ok: false, reason: '节点不存在' };
    if (fromItem.id === toItem.id) return { ok: false, reason: '不能连接到自身' };
    const output = getPorts(fromItem).outputs.find(port => port.name === fromPort);
    const input = getPorts(toItem).inputs.find(port => port.name === toPort);
    if (!output) return { ok: false, reason: '输出端口不存在' };
    if (!input) return { ok: false, reason: '输入端口不存在' };
    if (!portsCompatible(output, input)) {
        return { ok: false, reason: `类型不匹配：${output.dataType} → ${input.dataType}` };
    }
    const duplicate = connections.find(connection =>
        connection?.from?.nodeId === fromItem.id
        && connection?.from?.port === fromPort
        && connection?.to?.nodeId === toItem.id
        && connection?.to?.port === toPort
    );
    if (duplicate) return { ok: false, reason: '该连线已存在' };
    if (input.multi) return { ok: true };
    const replaces = connections.find(connection =>
        connection?.to?.nodeId === toItem.id && connection?.to?.port === toPort
    );
    return replaces ? { ok: true, replaces } : { ok: true };
}

function resolveNodeId(rawId, tempIds) {
    const id = String(rawId || '').trim();
    if (!id) throw new BoardTransactionError('INVALID_NODE_ID', '节点 ID 不能为空');
    return tempIds.get(id) || id;
}

function requireItem(snapshot, nodeId) {
    const item = findItem(snapshot, nodeId);
    if (!item) throw new BoardTransactionError('NODE_NOT_FOUND', `找不到节点：${nodeId}`);
    return item;
}

function findItem(snapshot, nodeId) {
    return snapshot.items.find(item => String(item.id) === String(nodeId)) || null;
}

function removePlanReferences(plans, item) {
    (plans || []).forEach(plan => {
        (plan.rows || []).forEach(row => {
            if (!Array.isArray(row.references)) return;
            row.references = row.references.filter(reference =>
                String(reference.itemId || '') !== String(item.id)
                && (!item.filePath || String(reference.filePath || '') !== String(item.filePath))
            );
        });
    });
}

function incrementSummary(summary, op, result) {
    if (op === 'node.create' || op === 'node.duplicate') summary.nodesCreated += 1;
    if (op === 'node.update') summary.nodesUpdated += 1;
    if (op === 'node.delete') {
        summary.nodesDeleted += 1;
        summary.connectionsDeleted += Number(result.removedConnections) || 0;
    }
    if (op === 'connection.create') {
        summary.connectionsCreated += 1;
        if (result.replacedConnectionId) summary.connectionsDeleted += 1;
    }
    if (op === 'connection.delete') summary.connectionsDeleted += 1;
    if (op === 'layout.arrange') summary.nodesArranged += result.nodeIds?.length || 0;
}

function emptySummary() {
    return {
        nodesCreated: 0,
        nodesUpdated: 0,
        nodesDeleted: 0,
        nodesArranged: 0,
        connectionsCreated: 0,
        connectionsDeleted: 0
    };
}

function stableId(prefix, transactionId, index) {
    const source = `${transactionId}:${index}`;
    let hash = 2166136261;
    for (let offset = 0; offset < source.length; offset += 1) {
        hash ^= source.charCodeAt(offset);
        hash = Math.imul(hash, 16777619);
    }
    return `${prefix}_${(hash >>> 0).toString(36)}`;
}

function normalizeRevision(value) {
    const revision = Number(value);
    return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function normalizeAppliedKeys(value) {
    return [...new Set((Array.isArray(value) ? value : [])
        .map(key => String(key || '').trim())
        .filter(Boolean))].slice(-MAX_APPLIED_KEYS);
}

function normalizeViewport(viewport = {}) {
    return {
        x: finiteOr(viewport.x, 0),
        y: finiteOr(viewport.y, 0),
        scale: Math.max(0.01, finiteOr(viewport.scale, 1))
    };
}

function finiteOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clampNumber(value, min, max, fallback) {
    return Math.max(min, Math.min(max, finiteOr(value, fallback)));
}

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}
