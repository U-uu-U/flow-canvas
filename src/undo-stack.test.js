const test = require('node:test');
const assert = require('node:assert');

let U;
test.before(async () => {
    U = await import('./undo-stack.js');
});

const items = (...names) => names.map(n => ({ id: n, kind: 'op', x: 0, y: 0 }));

test('snapshot: 剥掉运行态字段', () => {
    const snap = U.snapshot(
        [{ id: 'a', kind: 'op', runStatus: 'error', runError: 'boom', runResult: {} }],
        []
    );
    assert.deepStrictEqual(snap.items[0], { id: 'a', kind: 'op' });
});

test('snapshot: 深拷贝，后续修改不污染快照', () => {
    const live = [{ id: 'a', config: { text: 'before' } }];
    const edges = [{ id: 'e', from: { nodeId: 'a', port: 'o' }, to: { nodeId: 'b', port: 'i' } }];
    const snap = U.snapshot(live, edges);

    edges[0].from.nodeId = 'mutated';
    assert.strictEqual(snap.connections[0].from.nodeId, 'a');
});

test('undo/redo: 基本往返', () => {
    const stack = new U.UndoStack();
    assert.ok(!stack.canUndo());
    assert.ok(!stack.canRedo());

    stack.push(items('a'), []);                    // 记录 [a]
    const restored = stack.undo(items('a', 'b'), []); // 当前是 [a,b]
    assert.deepStrictEqual(restored.items.map(i => i.id), ['a']);
    assert.ok(!stack.canUndo());
    assert.ok(stack.canRedo());

    const redone = stack.redo(items('a'), []);
    assert.deepStrictEqual(redone.items.map(i => i.id), ['a', 'b']);
    assert.ok(stack.canUndo());
    assert.ok(!stack.canRedo());
});

test('undo/redo: 空栈返回 null', () => {
    const stack = new U.UndoStack();
    assert.strictEqual(stack.undo(items('a'), []), null);
    assert.strictEqual(stack.redo(items('a'), []), null);
});

test('push: 新操作清空重做栈', () => {
    const stack = new U.UndoStack();
    stack.push(items('a'), []);
    stack.undo(items('a', 'b'), []);
    assert.ok(stack.canRedo());

    stack.push(items('a', 'c'), []);
    assert.ok(!stack.canRedo(), '新操作后不应还能重做旧分支');
});

test('push: 超过深度上限时丢弃最早的快照', () => {
    const stack = new U.UndoStack(3);
    for (let i = 0; i < 5; i++) stack.push(items(`n${i}`), []);
    assert.strictEqual(stack.past.length, 3);
    assert.strictEqual(stack.past[0].items[0].id, 'n2');
});

test('多步连续撤销顺序正确', () => {
    const stack = new U.UndoStack();
    stack.push(items('a'), []);
    stack.push(items('a', 'b'), []);
    stack.push(items('a', 'b', 'c'), []);

    let current = items('a', 'b', 'c', 'd');
    current = stack.undo(current, []).items;
    assert.deepStrictEqual(current.map(i => i.id), ['a', 'b', 'c']);
    current = stack.undo(current, []).items;
    assert.deepStrictEqual(current.map(i => i.id), ['a', 'b']);
    current = stack.undo(current, []).items;
    assert.deepStrictEqual(current.map(i => i.id), ['a']);
    assert.strictEqual(stack.undo(current, []), null);
});

test('clear: 清空两个栈', () => {
    const stack = new U.UndoStack();
    stack.push(items('a'), []);
    stack.undo(items('a', 'b'), []);
    stack.clear();
    assert.ok(!stack.canUndo());
    assert.ok(!stack.canRedo());
});
