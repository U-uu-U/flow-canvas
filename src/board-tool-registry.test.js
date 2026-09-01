const test = require('node:test');
const assert = require('node:assert/strict');

let createBoardToolRegistry;
test.before(async () => {
    ({ createBoardToolRegistry } = await import('../shared/board-tool-registry.mjs'));
});

test('registry exposes stable OpenAI-compatible tool definitions', () => {
    const registry = createBoardToolRegistry({});
    const tools = registry.openAiTools();
    assert.deepEqual(tools.map(tool => tool.function.name), [
        'flow_canvas.board.get_snapshot',
        'flow_canvas.board.transaction.preview',
        'flow_canvas.board.transaction.apply',
        'flow_canvas.board.transaction.undo'
    ]);
    assert.equal(registry.risk('flow_canvas.board.get_snapshot'), 'read');
    assert.equal(registry.risk('flow_canvas.board.transaction.apply'), 'write');
    const applySchema = tools.find(tool => tool.function.name === 'flow_canvas.board.transaction.apply').function.parameters;
    assert.equal(applySchema.properties.schema.const, 'flow-canvas.board-transaction.v1');
    assert.ok(applySchema.properties.operations.items.properties.patch.properties.config);
    assert.deepEqual(applySchema.properties.operations.items.properties.mode.enum, ['horizontal', 'vertical', 'grid']);
});

test('registry routes transaction and undo arguments to one handler set', async () => {
    const calls = [];
    const registry = createBoardToolRegistry({
        getSnapshot: input => ({ scope: input.scope }),
        previewTransaction: transaction => ({ id: transaction.id, preview: true }),
        applyTransaction: transaction => ({ id: transaction.id, applied: true }),
        undoTransaction: undoToken => {
            calls.push(undoToken);
            return { undone: true };
        }
    });

    assert.deepEqual(await registry.execute('flow_canvas.board.get_snapshot', { scope: 'viewport' }), { scope: 'viewport' });
    assert.deepEqual(await registry.execute('flow_canvas.board.transaction.preview', {
        transaction: { id: 'tx' }
    }), { id: 'tx', preview: true });
    assert.deepEqual(await registry.execute('flow_canvas.board.transaction.apply', { id: 'tx' }), { id: 'tx', applied: true });
    assert.deepEqual(await registry.execute('flow_canvas.board.transaction.undo', { undoToken: 'undo-1' }), { undone: true });
    assert.deepEqual(calls, ['undo-1']);
});

test('registry rejects missing handlers and invalid undo arguments', async () => {
    const registry = createBoardToolRegistry({});
    await assert.rejects(
        registry.execute('flow_canvas.board.transaction.undo', {}),
        error => error.code === 'INVALID_ARGUMENTS'
    );
    await assert.rejects(
        registry.execute('flow_canvas.board.get_snapshot', {}),
        error => error.code === 'TOOL_UNAVAILABLE'
    );
});
