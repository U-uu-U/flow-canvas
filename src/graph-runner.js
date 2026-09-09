// ============================================================
// Flow Canvas — Graph Runner (拓扑执行器)
// ============================================================
// 从目标节点回溯上游依赖，按拓扑序逐个执行。
// 首版是同步 await：长任务会超时，刷新丢失。异步任务表是下一版的事。
// ============================================================

import { NODE_TYPES } from './node-types.js';
import {
    topoOrder,
    collectInputs,
    collectInputContext,
    mediaOutput,
    generatorResultOutput,
    downstreamOf
} from './graph-model.js';

export const STATUS = {
    IDLE: 'idle',
    QUEUED: 'queued',
    RUNNING: 'running',
    DONE: 'done',
    ERROR: 'error',
    CANCELED: 'canceled'
};

function cancellationError() {
    const error = new Error('生成任务已中断');
    error.name = 'AbortError';
    error.code = 'GENERATION_CANCELED';
    return error;
}

function isCancellationError(error) {
    return error?.code === 'GENERATION_CANCELED'
        || error?.name === 'AbortError'
        || /任务已中断|已取消|cancel(?:led|ed)?/i.test(error?.message || String(error || ''));
}

export class GraphRunner {
    /**
     * @param ctx {{ getItems, getConnections, onStatus, onResult?,
     *              getTextProvider?, getImageProvider?, getVideoProvider?, prepareImageReferences?,
     *              createGenerationTask?, updateGenerationTask?, recordGenerationError? }}
     *   getItems()       → Map<id, itemData> 或 itemData[]
     *   getConnections() → connection[]
     *   onStatus(id)     → 通知外部重绘该节点
     *   onResult(item, output) → 产物落地成新节点，可选
     *   getTextProvider / getImageProvider / getVideoProvider / prepareImageReferences
     *                    → 透传给节点的 execute(inputs, config, ctx)
     */
    constructor(ctx) {
        this.ctx = ctx;
        this.activeNodes = new Set();
        this.activeRuns = new Map();
        this.resultCache = new Map();
    }

    _items() {
        const raw = this.ctx.getItems();
        return raw instanceof Map ? raw : new Map((raw || []).map(i => [i.id, i]));
    }

    _setStatus(item, status, error = '') {
        if (status === STATUS.QUEUED || (status === STATUS.RUNNING && !(Number(item.runStartedAt) > 0))) {
            item.runStartedAt = Date.now();
        }
        if (status === STATUS.IDLE) delete item.runStartedAt;
        item.runStatus = status;
        item.runError = error;
        this.ctx.onStatus?.(item.id);
    }

    /**
     * 执行 targetId 及其全部上游依赖。
     * @returns {{ ok: boolean, reason?: string, ran?: string[] }}
     */
    async runFrom(targetId, options = {}) {
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

        if (order.some(id => this.activeNodes.has(id))) {
            return { ok: false, reason: '该节点链正在执行' };
        }

        // 只锁本次运行真正涉及的节点。互不相干的链可并发，共享上游的链
        // 仍会被拒绝，避免同一节点的状态和结果被两个运行互相覆盖。
        order.forEach(id => this.activeNodes.add(id));
        const runState = { targetId, order, items, canceled: false };
        this.activeRuns.set(targetId, runState);
        const runCache = new Map();

        order.forEach(id => {
            const item = items.get(id);
            if (item) this._setStatus(item, STATUS.QUEUED);
        });

        try {
            for (const id of order) {
                const item = items.get(id);
                if (!item) continue;

                if (runState.canceled) {
                    this._setStatus(target, STATUS.CANCELED, '生成任务已中断');
                    return { ok: false, canceled: true, reason: '生成任务已中断', ran: order };
                }

                // 上游失败时该节点已被标 error，跳过
                if (item.runStatus === STATUS.ERROR) continue;

                this._setStatus(item, STATUS.RUNNING);

                try {
                    const configOverride = options?.configOverrides instanceof Map
                        ? options.configOverrides.get(id)
                        : options?.configOverrides?.[id];
                    const persistedProduct = id !== targetId ? generatorResultOutput(item) : {};
                    const reusedProduct = Object.keys(persistedProduct).length > 0;
                    const output = reusedProduct
                        ? persistedProduct
                        : await this._execute(item, connections, runCache, configOverride, runState);
                    if (runState.canceled) throw cancellationError();
                    runCache.set(id, output);
                    this.resultCache.set(id, output);
                    // 生成结果自动落地成新节点。没有 onResult 时静默跳过，
                    // 保证 runner 在无宿主画布的测试里仍可独立运行。
                    // await：落地是异步的（要建卡片再连溯源边），不等的话
                    // 下一个节点可能在结果节点存在之前就跑起来。
                    // Keep downloaded outputs cached even if canvas persistence fails.
                    if (!reusedProduct && item.kind === 'op' && typeof this.ctx.onResult === 'function') {
                        try {
                            const landedOutputs = Array.isArray(output?._batchResults)
                                ? output._batchResults
                                : [output];
                            for (const landedOutput of landedOutputs) {
                                if (runState.canceled) throw cancellationError();
                                await this.ctx.onResult(item, landedOutput);
                            }
                        } catch (landErr) {
                            if (runState.canceled || isCancellationError(landErr)) throw landErr;
                            console.warn('[GraphRunner] 结果落地失败', landErr);
                            throw new Error(`产物已生成，但画布保存失败：${landErr?.message || String(landErr)}。可从任务记录拉取产物`);
                        }
                    }
                    if (runState.canceled) throw cancellationError();
                    this._setStatus(item, STATUS.DONE);
                } catch (err) {
                    const message = err?.message || String(err);
                    if (runState.canceled || isCancellationError(err)) {
                        runState.canceled = true;
                        this._setStatus(target, STATUS.CANCELED, '生成任务已中断');
                        return { ok: false, canceled: true, reason: '生成任务已中断', ran: order };
                    }
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
            order.forEach(id => {
                const item = items.get(id);
                if ([STATUS.QUEUED, STATUS.RUNNING].includes(item?.runStatus)) {
                    this._setStatus(item, STATUS.CANCELED, runState.canceled ? '生成任务已中断' : '本次任务已停止，节点未执行');
                }
            });
            order.forEach(id => this.activeNodes.delete(id));
            this.activeRuns.delete(targetId);
        }

        return { ok: true, ran: order };
    }

    _label(item) {
        if (item.kind === 'op') return NODE_TYPES[item.nodeType]?.title || item.nodeType;
        return item.filePath?.split(/[/\\]/).pop() || item.id;
    }

    /**
     * 单节点执行。media 是特例，不走 NODE_TYPES。
     */
    async _execute(item, connections, resultCache = this.resultCache, configOverride = null, runState = null) {
        if (item.kind !== 'op') {
            const out = mediaOutput(item);
            if (!Object.keys(out).length) throw new Error('素材缺少文件路径');
            return out;
        }

        const def = NODE_TYPES[item.nodeType];
        if (!def) throw new Error(`未知节点类型：${item.nodeType}`);
        if (typeof def.execute !== 'function') throw new Error('该节点类型未实现 execute');

        const items = this._items();
        const inputs = collectInputs(item, connections, resultCache);
        const inputContext = collectInputContext(item, connections, resultCache, items);
        const config = this._resolvedConfig(def, {
            ...(item.config || {}),
            ...(configOverride && typeof configOverride === 'object' ? configOverride : {})
        });

        // execute 需要 provider 与参考图预处理。之前只传 { item }，
        // 生成类节点必然在 getImageProvider() 处抛错。
        const result = await def.execute(inputs, config, {
            item,
            getTextProvider: this.ctx.getTextProvider,
            getImageProvider: this.ctx.getImageProvider,
            getVideoProvider: this.ctx.getVideoProvider,
            prepareImageReferences: this.ctx.prepareImageReferences,
            getImageIntentPipelineMode: this.ctx.getImageIntentPipelineMode,
            createGenerationTask: this.ctx.createGenerationTask,
            updateGenerationTask: this.ctx.updateGenerationTask,
            recordGenerationError: this.ctx.recordGenerationError,
            isCancelled: () => runState?.canceled === true,
            inputContext
        });
        return result || {};
    }

    async cancel(targetId) {
        const runState = this.activeRuns.get(targetId)
            || [...this.activeRuns.values()].find(run => run.order.includes(targetId));
        if (!runState || runState.canceled) return false;
        runState.canceled = true;
        const pendingIds = runState.order.filter(id =>
            [STATUS.QUEUED, STATUS.RUNNING].includes(runState.items.get(id)?.runStatus));
        pendingIds.forEach(id => this._setStatus(runState.items.get(id), STATUS.CANCELED, '生成任务已中断'));
        const canceled = await Promise.allSettled(pendingIds.map(id => Promise.resolve().then(() => this.ctx.cancelGenerationTasks?.(id))));
        canceled.filter(result => result.status === 'rejected').forEach(result => {
            console.warn('[GraphRunner] 中断本地等待失败', result.reason);
        });
        return true;
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
