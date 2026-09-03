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
}
