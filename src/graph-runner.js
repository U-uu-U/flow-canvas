// ============================================================
// Flow Canvas — Graph Runner (拓扑执行器)
// ============================================================
// 从目标节点回溯上游依赖，按拓扑序逐个执行。
// 首版是同步 await：长任务会超时，刷新丢失。异步任务表是下一版的事。
// ============================================================

import { NODE_TYPES } from './node-types.js';
import { topoOrder, collectInputs, mediaOutput, downstreamOf } from './graph-model.js';

export const STATUS = {
    IDLE: 'idle',
    QUEUED: 'queued',
    RUNNING: 'running',
    DONE: 'done',
    ERROR: 'error'
};

export class GraphRunner {
    /**
     * @param ctx {{ getItems, getConnections, onStatus }}
     *   getItems()       → Map<id, itemData> 或 itemData[]
     *   getConnections() → connection[]
     *   onStatus(id)     → 通知外部重绘该节点
     */
    constructor(ctx) {
        this.ctx = ctx;
        this.running = false;
        this.resultCache = new Map();
        this.abortController = null;
    }

    _items() {
        const raw = this.ctx.getItems();
        return raw instanceof Map ? raw : new Map((raw || []).map(i => [i.id, i]));
    }

    _setStatus(item, status, error = '') {
        item.runStatus = status;
        item.runError = error;
        this.ctx.onStatus?.(item.id);
    }

    /**
     * 执行 targetId 及其全部上游依赖。
     * @returns {{ ok: boolean, reason?: string, ran?: string[] }}
     */
    /** 取消当前正在执行的任务。无任务时无操作。 */
    abort() {
        if (this.abortController) {
            this.abortController.abort();
        }
    }

    async runFrom(targetId) {
        if (this.running) return { ok: false, reason: '已有任务正在执行' };

        const items = this._items();
        const connections = this.ctx.getConnections() || [];
        const target = items.get(targetId);
        if (!target) return { ok: false, reason: '节点不存在' };

        const { order, missing, cyclic } = topoOrder(targetId, items, connections);
        if (cyclic) return { ok: false, reason: '存在环形依赖，无法执行' };
        if (!order.length) return { ok: false, reason: '无可执行节点' };
        if (missing.length) {
            console.warn('[Runner] 连线引用了已删除的节点:', missing);
        }

        this.running = true;
        this.abortController = new AbortController();
        const { signal } = this.abortController;

        // 每次运行都从干净的缓存开始 —— 上次的结果可能已过期
        this.resultCache = new Map();

        order.forEach(id => {
            const item = items.get(id);
            if (item) this._setStatus(item, STATUS.QUEUED);
        });

        try {
            for (const id of order) {
                if (signal.aborted) {
                    order.forEach(pendingId => {
                        const item = items.get(pendingId);
                        if (item && item.runStatus !== STATUS.DONE && item.runStatus !== STATUS.ERROR) {
                            this._setStatus(item, STATUS.IDLE);
                        }
                    });
                    return { ok: false, reason: '已中断', aborted: true, ran: order };
                }

                const item = items.get(id);
                if (!item) continue;

                // 上游失败时该节点已被标 error，跳过
                if (item.runStatus === STATUS.ERROR) continue;

                this._setStatus(item, STATUS.RUNNING);

                try {
                    const output = await this._execute(item, connections, signal);
                    if (signal.aborted) {
                        this._setStatus(item, STATUS.IDLE);
                        continue;
                    }
                    this.resultCache.set(id, output);
                    this._setStatus(item, STATUS.DONE);
                } catch (err) {
                    if (signal.aborted) {
                        this._setStatus(item, STATUS.IDLE);
                        continue;
                    }
                    const message = err?.message || String(err);
                    this._setStatus(item, STATUS.ERROR, message);

                    // 级联标错下游，并跳过它们
                    downstreamOf(id, connections).forEach(downId => {
                        const down = items.get(downId);
                        if (down && order.includes(downId)) {
                            this._setStatus(down, STATUS.ERROR, `上游节点「${this._label(item)}」执行失败`);
                        }
                    });

                    return { ok: false, reason: message, failedAt: id, ran: order };
                }
            }
        } finally {
            this.running = false;
            this.abortController = null;
        }

        if (signal.aborted) return { ok: false, reason: '已中断', aborted: true, ran: order };
        return { ok: true, ran: order };
    }

    _label(item) {
        if (item.kind === 'op') return NODE_TYPES[item.nodeType]?.title || item.nodeType;
        return item.filePath?.split(/[/\\]/).pop() || item.id;
    }

    /**
     * 单节点执行。media 是特例，不走 NODE_TYPES。
     */
    async _execute(item, connections) {
        if (item.kind !== 'op') {
            const out = mediaOutput(item);
            if (!Object.keys(out).length) throw new Error('素材缺少文件路径');
            return out;
        }

        const def = NODE_TYPES[item.nodeType];
        if (!def) throw new Error(`未知节点类型：${item.nodeType}`);
        if (typeof def.execute !== 'function') throw new Error('该节点类型未实现 execute');

        const inputs = collectInputs(item, connections, this.resultCache);
        const config = this._resolvedConfig(def, item.config);

        const result = await def.execute(inputs, config, { item });
        return result || {};
    }

    /**
     * 用节点类型声明的 default 补齐用户未填的字段。
     */
    _resolvedConfig(def, config = {}) {
        const resolved = { ...config };
        (def.config || []).forEach(field => {
            if (resolved[field.key] === undefined || resolved[field.key] === '') {
                if (field.default !== undefined) resolved[field.key] = field.default;
            }
        });
        return resolved;
    }

    /**
     * 取某节点最近一次的执行结果，供预览节点渲染。
     */
    getResult(nodeId) {
        return this.resultCache.get(nodeId) || null;
    }

    /** 把所有节点的运行态重置为 idle（加载数据后调用）。 */
    resetAll() {
        this.resultCache = new Map();
        this._items().forEach(item => {
            if (item.runStatus && item.runStatus !== STATUS.IDLE) {
                this._setStatus(item, STATUS.IDLE);
            }
        });
    }
}
