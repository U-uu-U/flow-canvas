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

/**
 * 判定「用户中断了生成」。
 *
 * 只认本应用自己打的两个标记：`code === 'GENERATION_CANCELED'` 与 `name === 'AbortError'`。
 * 这三处产出中断错误的代码都会带上它们：
 *   - graph-runner.js 的 cancellationError()
 *   - node-types.js 的 throwIfGenerationCanceled()
 *   - electron-main/mcp-bridge.js 的 generationCanceledError()
 *
 * 这里**不能**再按文本匹配（旧实现含 /已取消|cancel/i）：供应商返回的正常失败
 * 只要文案里带 "cancelled"，就会被当成用户中断——节点被标成 canceled、真实的
 * 失败原因被丢弃、重试入口消失。凡是要走「用户中断」语义的地方，请打标记，
 * 不要靠文案。
 */
function isCancellationError(error) {
    return error?.code === 'GENERATION_CANCELED'
        || error?.name === 'AbortError';
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
        // onStatus 是宿主的重绘回调，不属于运行逻辑的一部分。它抛错必须被隔离：
        // runFrom 的加锁与解锁之间到处都在调 _setStatus，一旦异常逃逸，
        // finally 就不会执行，activeNodes 永久残留 → 该节点链在本会话内
        // 再也跑不起来（只能重启）。状态已经写入 item，重绘失败不影响正确性。
        try {
            this.ctx.onStatus?.(item.id);
        } catch (statusError) {
            console.error('[Runner] onStatus 回调失败（已忽略）:', statusError);
        }
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

        // Shared references are read per run; only nodes doing work own status and cancellation.
        const readOnlyInputs = new Map(order.flatMap(id => {
            if (id === targetId) return [];
            const item = items.get(id);
            const override = options?.configOverrides instanceof Map
                ? options.configOverrides.get(id) : options?.configOverrides?.[id];
            const config = { ...item?.config, ...override };
            const product = generatorResultOutput(item);
            const readOnly = item?.kind !== 'op'
                || Object.keys(product).length > 0
                || (item.nodeType === 'text' && !config.useAi);
            return readOnly ? [[id, { item: { ...item, config }, product }]] : [];
        }));
        const ownedNodes = order.filter(id => !readOnlyInputs.has(id));
        ownedNodes.forEach(id => this.activeNodes.add(id));
        const runState = { targetId, order, ownedNodes, items, canceled: false };
        this.activeRuns.set(targetId, runState);
        const runCache = new Map();

        ownedNodes.forEach(id => {
            const item = items.get(id);
            if (item) this._setStatus(item, STATUS.QUEUED);
        });

        try {
            for (const id of order) {
                const source = readOnlyInputs.get(id);
                const item = source?.item || items.get(id);
                if (!item) continue;

                if (runState.canceled) {
                    this._setStatus(target, STATUS.CANCELED, '生成任务已中断');
                    return { ok: false, canceled: true, reason: '生成任务已中断', ran: order };
                }

                // 上游失败时该节点已被标 error，跳过
                if (!readOnlyInputs.has(id) && item.runStatus === STATUS.ERROR) continue;

                if (!readOnlyInputs.has(id)) this._setStatus(item, STATUS.RUNNING);

                try {
                    const configOverride = source ? null : options?.configOverrides instanceof Map
                        ? options.configOverrides.get(id)
                        : options?.configOverrides?.[id];
                    const persistedProduct = source ? source.product : id !== targetId ? generatorResultOutput(item) : {};
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
                    if (!readOnlyInputs.has(id) && !reusedProduct && item.kind === 'op' && typeof this.ctx.onResult === 'function') {
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
                    if (!readOnlyInputs.has(id)) this._setStatus(item, STATUS.DONE);
                } catch (err) {
                    const message = err?.message || String(err);
                    if (runState.canceled || isCancellationError(err)) {
                        runState.canceled = true;
                        this._setStatus(target, STATUS.CANCELED, '生成任务已中断');
                        return { ok: false, canceled: true, reason: '生成任务已中断', ran: order };
                    }
                    if (!readOnlyInputs.has(id)) this._setStatus(item, STATUS.ERROR, message);

                    // 级联标错下游，并跳过它们
                    downstreamOf(id, connections).forEach(downId => {
                        const down = items.get(downId);
                        if (down && ownedNodes.includes(downId)) {
                            this._setStatus(down, STATUS.ERROR, `上游节点「${this._label(item)}」执行失败`);
                        }
                    });

                    return { ok: false, reason: message, failedAt: id, ran: order };
                }
            }
        } finally {
            ownedNodes.forEach(id => {
                const item = items.get(id);
                if ([STATUS.QUEUED, STATUS.RUNNING].includes(item?.runStatus)) {
                    this._setStatus(item, STATUS.CANCELED, runState.canceled ? '生成任务已中断' : '本次任务已停止，节点未执行');
                }
            });
            ownedNodes.forEach(id => this.activeNodes.delete(id));
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
            validateGenerationRequest: this.ctx.validateGenerationRequest,
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
            || [...this.activeRuns.values()].find(run => run.ownedNodes.includes(targetId));
        if (!runState || runState.canceled) return false;
        runState.canceled = true;
        const pendingIds = runState.ownedNodes.filter(id =>
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
