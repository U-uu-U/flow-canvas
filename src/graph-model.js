// ============================================================
// Flow Canvas — Graph Model (端口推导 / 连线校验 / 拓扑排序)
// ============================================================
// 纯数据层，不依赖 DOM 和 Konva，可直接单测。
// ============================================================

import { NODE_TYPES } from './node-types.js';

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'tif', 'gif'];
const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm'];

/**
 * 素材文件的输出端口 dataType。
 * 与 canvas.js 的 _getFileType() 分类保持一致，但 gif 归到 image
 * （作为参考图时 gif 首帧就是图片）。
 */
function mediaDataType(filePath) {
    const ext = String(filePath || '').split('.').pop().toLowerCase();
    if (IMAGE_EXTS.includes(ext)) return 'image';
    if (VIDEO_EXTS.includes(ext)) return 'video';
    return 'file';
}

function mediaItemDataType(item) {
    const explicitType = String(item?.mediaType || '').toLowerCase();
    if (explicitType === 'image' || explicitType === 'video') return explicitType;
    if (explicitType === 'audio' || explicitType === 'document' || explicitType === 'other') return 'file';
    return mediaDataType(item?.filePath);
}

/**
 * 推导节点的端口。端口不持久化，每次由 kind / nodeType 现算。
 * @returns {{ inputs: Array<{name,dataType}>, outputs: Array<{name,dataType}> }}
 */
export function getPorts(item) {
    if (!item) return { inputs: [], outputs: [] };

    if (item.kind === 'op') {
        const def = NODE_TYPES[item.nodeType];
        if (!def) return { inputs: [], outputs: [] };
        return {
            inputs: def.inputs || [],
            outputs: def.outputs || []
        };
    }

    // media：单个输出端口，外加一个可多连的 source 输入承接溯源边
    // 或普通图片生成的上游参考边。
    // source 不参与执行（mediaOutput 只看 filePath），存在的意义是让
    // 「这张图是从哪个节点生成的」有个可视化落点。
    return {
        inputs: [{ name: 'source', dataType: 'any', multi: true }],
        outputs: [{ name: 'out', dataType: mediaItemDataType(item) }]
    };
}

const LEGACY_GENERATOR_INPUT_PORTS = {
    image: new Set(['prompt', 'reference']),
    video: new Set(['prompt', 'image', 'video', 'audio'])
};

export function normalizeGeneratorInputPort(item, portName) {
    const legacyPorts = item?.kind === 'op' ? LEGACY_GENERATOR_INPUT_PORTS[item.nodeType] : null;
    return legacyPorts?.has(portName) ? 'source' : portName;
}

export function normalizeGeneratorInputConnections(connections = [], items = []) {
    const byId = items instanceof Map
        ? items
        : new Map((items || []).map(item => [item.id, item]));
    const seen = new Set();
    const normalized = [];
    for (const connection of connections || []) {
        const target = byId.get(connection?.to?.nodeId);
        const port = normalizeGeneratorInputPort(target, connection?.to?.port);
        const next = port === connection?.to?.port
            ? connection
            : { ...connection, to: { ...connection.to, port } };
        const key = `${next.kind || 'flow'}|${next.from?.nodeId}:${next.from?.port}|${next.to?.nodeId}:${next.to?.port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(next);
    }
    return normalized;
}

export function convertGeneratorOutputConnections(connections = [], nodeId) {
    if (!nodeId) return [...(connections || [])];
    return (connections || []).map(connection => {
        if (connection?.to?.nodeId === nodeId) {
            return {
                ...connection,
                kind: 'history',
                to: { ...connection.to, port: 'source' }
            };
        }
        if (connection?.from?.nodeId === nodeId) {
            return {
                ...connection,
                from: { ...connection.from, port: 'out' }
            };
        }
        return connection;
    });
}

function findPort(item, portName, direction) {
    const ports = getPorts(item);
    const list = direction === 'output' ? ports.outputs : ports.inputs;
    return list.find(p => p.name === portName) || null;
}

/**
 * dataType 兼容判断。'any' 双向通配。
 */
export function typesCompatible(fromType, toType) {
    if (!fromType || !toType) return false;
    if (fromType === 'any' || toType === 'any') return true;
    return fromType === toType;
}

export function portsCompatible(outputPort, inputPort) {
    if (!outputPort || !inputPort) return false;
    if (Array.isArray(inputPort.accepts) && inputPort.accepts.length) {
        return outputPort.dataType === 'any' || inputPort.accepts.includes(outputPort.dataType);
    }
    return typesCompatible(outputPort.dataType, inputPort.dataType);
}

/**
 * 只保留参与执行的边。conn.kind === 'history' 是溯源链接
 * （「这张图是从哪个节点生成的」），可视化用，不进执行图，
 * 否则产物节点会反过来成为源节点的上游，立刻形成环。
 * 未标 kind 的边一律视为执行边，兼容旧 board.json。
 */
export function executableEdges(connections = []) {
    return connections.filter(c => c.kind !== 'history');
}

/**
 * 从 fromId 出发能否沿 connections 到达 toId（DFS）。
 * 用于成环检测：新连线 A→B 若 B 已能到达 A，则会成环。
 */
export function reachable(fromId, toId, connections) {
    if (fromId === toId) return true;
    const edges = executableEdges(connections);
    const seen = new Set([fromId]);
    const stack = [fromId];
    while (stack.length) {
        const current = stack.pop();
        for (const conn of edges) {
            if (conn.from.nodeId !== current) continue;
            const next = conn.to.nodeId;
            if (next === toId) return true;
            if (!seen.has(next)) {
                seen.add(next);
                stack.push(next);
            }
        }
    }
    return false;
}

/**
 * 校验一条待建连线是否合法。
 * @returns {{ ok: boolean, reason?: string, replaces?: object }}
 *   replaces —— 若目标 input 端口已被占用，返回需要移除的旧连线（新线替换旧线）
 */
export function canConnect(fromItem, fromPort, toItem, toPort, connections = []) {
    if (!fromItem || !toItem) return { ok: false, reason: '节点不存在' };
    if (fromItem.id === toItem.id) return { ok: false, reason: '不能连接到自身' };

    const outPort = findPort(fromItem, fromPort, 'output');
    if (!outPort) return { ok: false, reason: '输出端口不存在' };

    const inPort = findPort(toItem, toPort, 'input');
    if (!inPort) return { ok: false, reason: '输入端口不存在' };

    if (!portsCompatible(outPort, inPort)) {
        return { ok: false, reason: `类型不匹配：${outPort.dataType} → ${inPort.dataType}` };
    }

    const duplicate = connections.find(c =>
        c.from.nodeId === fromItem.id && c.from.port === fromPort &&
        c.to.nodeId === toItem.id && c.to.port === toPort
    );
    if (duplicate) return { ok: false, reason: '该连线已存在' };

    if (reachable(toItem.id, fromItem.id, connections)) {
        return { ok: false, reason: '不能形成环形依赖' };
    }

    // multi 端口可接多条上游（多图参考等）；普通端口只允许一条，新线替换旧线。
    if (inPort.multi) return { ok: true };

    const occupying = connections.find(c =>
        c.to.nodeId === toItem.id && c.to.port === toPort
    );

    return occupying ? { ok: true, replaces: occupying } : { ok: true };
}

/**
 * 从目标节点反向收集上游依赖子图，再做 Kahn 拓扑排序。
 * @returns {{ order: string[], missing: string[] }}
 *   order   —— 执行序（目标节点在最后）
 *   missing —— connections 里引用了但 items 中不存在的节点 id
 */
export function topoOrder(targetId, items, allConnections = []) {
    const connections = executableEdges(allConnections);
    const byId = items instanceof Map
        ? items
        : new Map((items || []).map(it => [it.id, it]));

    if (!byId.has(targetId)) return { order: [], missing: [targetId] };

    // 1. 反向 BFS 收集上游闭包
    const subgraph = new Set([targetId]);
    const missing = new Set();
    const queue = [targetId];
    while (queue.length) {
        const current = queue.shift();
        for (const conn of connections) {
            if (conn.to.nodeId !== current) continue;
            const upstream = conn.from.nodeId;
            if (!byId.has(upstream)) {
                missing.add(upstream);
                continue;
            }
            if (!subgraph.has(upstream)) {
                subgraph.add(upstream);
                queue.push(upstream);
            }
        }
    }

    // 2. 仅保留子图内部的边
    const edges = connections.filter(c =>
        subgraph.has(c.from.nodeId) && subgraph.has(c.to.nodeId)
    );

    // 3. Kahn
    const indegree = new Map();
    subgraph.forEach(id => indegree.set(id, 0));
    edges.forEach(c => indegree.set(c.to.nodeId, indegree.get(c.to.nodeId) + 1));

    const ready = [...subgraph].filter(id => indegree.get(id) === 0);
    const order = [];
    while (ready.length) {
        const id = ready.shift();
        order.push(id);
        for (const conn of edges) {
            if (conn.from.nodeId !== id) continue;
            const next = conn.to.nodeId;
            const left = indegree.get(next) - 1;
            indegree.set(next, left);
            if (left === 0) ready.push(next);
        }
    }

    // 有环时 order 会短于 subgraph —— canConnect 已阻止成环，
    // 这里作为脏数据兜底：返回空序，由调用方报错。
    if (order.length !== subgraph.size) {
        return { order: [], missing: [...missing], cyclic: true };
    }

    return { order, missing: [...missing] };
}

/**
 * 按端口名组装 execute() 的 inputs 对象。
 * @param resultCache Map<nodeId, Record<portName, value>>
 */
export function collectInputs(item, allConnections = [], resultCache = new Map()) {
    const connections = executableEdges(allConnections);
    const inputs = {};
    const { inputs: inPorts } = getPorts(item);

    for (const port of inPorts) {
        const conns = connections.filter(c =>
            c.to.nodeId === item.id && normalizeGeneratorInputPort(item, c.to.port) === port.name
        );
        if (!conns.length) continue;

        const values = [];
        for (const conn of conns) {
            const upstream = resultCache.get(conn.from.nodeId);
            if (upstream && conn.from.port in upstream) {
                values.push(upstream[conn.from.port]);
            }
        }
        if (!values.length) continue;

        // multi 端口收集成数组（可接多条上游）；普通端口取单值。
        inputs[port.name] = port.multi ? values : values[0];
    }

    return inputs;
}

/**
 * 保留生成输入的连接身份。collectInputs 只负责给节点值，这里额外提供
 * 引用胶囊、来源节点和上传顺序需要的确定性事实。
 */
export function collectInputContext(item, allConnections = [], resultCache = new Map(), items = []) {
    const byId = items instanceof Map
        ? items
        : new Map((items || []).map(entry => [entry.id, entry]));
    return executableEdges(allConnections)
        .filter(connection => connection.to.nodeId === item.id)
        .map((connection, connectionIndex) => {
            const upstream = resultCache.get(connection.from.nodeId);
            const rawValue = upstream && connection.from.port in upstream
                ? upstream[connection.from.port]
                : undefined;
            const values = Array.isArray(rawValue) ? rawValue.flat() : (rawValue == null ? [] : [rawValue]);
            const source = byId.get(connection.from.nodeId) || null;
            return {
                connectionId: String(connection.id || ''),
                connectionIndex,
                sourceNodeId: String(connection.from.nodeId || ''),
                sourcePort: String(connection.from.port || ''),
                targetPort: normalizeGeneratorInputPort(item, connection.to.port),
                values,
                source: source ? {
                    id: source.id,
                    kind: source.kind || 'media',
                    nodeType: source.nodeType || null,
                    filePath: source.filePath || null,
                    fromNodeId: source.fromNodeId || null,
                    mediaType: source.mediaType || null,
                    width: Number(source.width) || null,
                    height: Number(source.height) || null
                } : null
            };
        });
}

/**
 * media 节点的"执行"结果：本地文件 URL。
 * 与 canvas.js 的 _loadThumbnail() 用同一套 local-res:// 协议。
 */
export function mediaOutput(item) {
    const { outputs } = getPorts(item);
    const port = outputs[0];
    if (!port || !item.filePath) return {};
    return { [port.name]: 'local-res://' + encodeURIComponent(item.filePath) };
}

/**
 * 移除与某节点相关的所有连线，返回新数组。
 */
export function connectionsWithout(nodeId, connections = []) {
    return connections.filter(c => c.from.nodeId !== nodeId && c.to.nodeId !== nodeId);
}

/**
 * 找出 targetId 的所有下游节点（含间接）。执行失败时用来级联标错。
 */
export function downstreamOf(targetId, allConnections = []) {
    const connections = executableEdges(allConnections);
    const result = new Set();
    const stack = [targetId];
    while (stack.length) {
        const current = stack.pop();
        for (const conn of connections) {
            if (conn.from.nodeId !== current) continue;
            const next = conn.to.nodeId;
            if (!result.has(next)) {
                result.add(next);
                stack.push(next);
            }
        }
    }
    return [...result];
}
