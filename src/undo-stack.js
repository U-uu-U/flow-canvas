// ============================================================
// Flow Canvas — Undo Stack (快照栈)
// ============================================================
// items + connections 数据量是 KB 级，直接整体深拷贝入栈，
// 不做增量 diff。
// ============================================================

const MAX_DEPTH = 50;

/** 运行态字段不进快照 —— 撤销不应该恢复上一次的运行结果。 */
function stripRuntime(item) {
    const clean = { ...item };
    delete clean.runStatus;
    delete clean.runError;
    delete clean.runResult;
    return clean;
}

export function snapshot(items, connections) {
    return {
        items: (items || []).map(stripRuntime),
        connections: JSON.parse(JSON.stringify(connections || []))
    };
}

export function snapshotState(state = {}) {
    const clean = JSON.parse(JSON.stringify(state || {}));
    clean.items = (clean.items || []).map(stripRuntime);
    clean.connections = Array.isArray(clean.connections) ? clean.connections : [];
    return clean;
}

export class UndoStack {
    constructor(maxDepth = MAX_DEPTH) {
        this.maxDepth = maxDepth;
        this.past = [];
        this.future = [];
    }

    /**
     * 记录变更前的状态。任何新操作都会清空重做栈。
     */
    push(items, connections) {
        this.past.push(snapshot(items, connections));
        if (this.past.length > this.maxDepth) this.past.shift();
        this.future = [];
    }

    canUndo() { return this.past.length > 0; }
    canRedo() { return this.future.length > 0; }

    /**
     * @param items/connections 当前状态，用于压入重做栈
     * @returns 要恢复的快照，无可撤销时返回 null
     */
    undo(items, connections) {
        if (!this.past.length) return null;
        this.future.push(snapshot(items, connections));
        if (this.future.length > this.maxDepth) this.future.shift();
        return this.past.pop();
    }

    redo(items, connections) {
        if (!this.future.length) return null;
        this.past.push(snapshot(items, connections));
        if (this.past.length > this.maxDepth) this.past.shift();
        return this.future.pop();
    }

    clear() {
        this.past = [];
        this.future = [];
    }

    resetState(state) {
        this.past = [snapshotState(state)];
        this.future = [];
    }

    commitState(state) {
        const next = snapshotState(state);
        const current = this.past[this.past.length - 1];
        if (current && JSON.stringify(current) === JSON.stringify(next)) return false;
        this.past.push(next);
        if (this.past.length > this.maxDepth) this.past.shift();
        this.future = [];
        return true;
    }

    undoState() {
        if (this.past.length <= 1) return null;
        this.future.push(this.past.pop());
        if (this.future.length > this.maxDepth) this.future.shift();
        return snapshotState(this.past[this.past.length - 1]);
    }

    redoState() {
        if (!this.future.length) return null;
        const target = this.future.pop();
        this.past.push(target);
        if (this.past.length > this.maxDepth) this.past.shift();
        return snapshotState(target);
    }
}
