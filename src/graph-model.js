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

    // media：无输入，单个输出端口
    return {
        inputs: [],
        outputs: [{ name: 'out', dataType: mediaDataType(item.filePath) }]
    };
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

/**
 * 从 fromId 出发能否沿 connections 到达 toId（DFS）。
 * 用于成环检测：新连线 A→B 若 B 已能到达 A，则会成环。
 */
export function reachable(fromId, toId, connections) {
    if (fromId === toId) return true;
    const seen = new Set([fromId]);
    const stack = [fromId];
    while (stack.length) {
        const current = stack.pop();
        for (const conn of connections) {
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

    if (!typesCompatible(outPort.dataType, inPort.dataType)) {
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

    // 同一 input 端口只允许一条连线，新线替换旧线
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
export function topoOrder(targetId, items, connections = []) {
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
export function collectInputs(item, connections = [], resultCache = new Map()) {
    const inputs = {};
    const { inputs: inPorts } = getPorts(item);

    for (const port of inPorts) {
        const conn = connections.find(c =>
            c.to.nodeId === item.id && c.to.port === port.name
        );
        if (!conn) continue;
        const upstream = resultCache.get(conn.from.nodeId);
        if (upstream && conn.from.port in upstream) {
            inputs[port.name] = upstream[conn.from.port];
        }
    }

    return inputs;
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
export function downstreamOf(targetId, connections = []) {
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
