import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { generationNodeSignature } from '../shared/generation-node-state.mjs';
import { appendGeneratorResult, rotateGeneratorResults, setGeneratorResultLayout } from './generator-result-stack.js';
import { generatorResultOutput } from './graph-model.js';

const originalLoad = Module._load;
const originalDOMMatrix = Object.getOwnPropertyDescriptor(globalThis, 'DOMMatrix');
let CanvasManager;
try {
    // Only routing prototypes are exercised; Konva's optional native renderer is unused.
    Module._load = function (request, ...args) {
        return request === 'canvas' ? {} : originalLoad.call(this, request, ...args);
    };
    ({ CanvasManager } = await import('./canvas.js'));
} finally {
    Module._load = originalLoad;
    if (originalDOMMatrix) Object.defineProperty(globalThis, 'DOMMatrix', originalDOMMatrix);
    else delete globalThis.DOMMatrix;
}

const clone = value => structuredClone(value);
const firstArgs = mock => mock.mock.calls[0].arguments;

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function harness(t, { activeProjectId = 'original', staleSource = false } = {}) {
    const source = {
        id: 'source', kind: 'op', nodeType: 'image', config: { prompt: 'original prompt', model: 'image-model' },
        x: 10, y: 20, width: 400, height: 300, runStatus: 'running', runError: '', runStartedAt: 1234
    };
    const context = {
        projectId: 'original', expectedNode: clone(source), runState: { canceled: false }, operationId: 'run:source:settled'
    };
    const output = { image: 'local-res://%2Fone.png', _resultFilePath: '/one.png' };
    const landedSource = {
        id: source.id, kind: 'media', mediaType: 'image', filePath: '/one.png',
        x: 10, y: 20, width: 400, height: 300, generation: { nodeType: 'image', config: clone(source.config) }
    };
    const reply = {
        success: true, projectId: 'original', nodeId: source.id,
        sourceNode: clone(landedSource), resultNodeId: source.id, duplicate: false
    };
    const order = [];
    const flush = t.mock.fn(async () => { order.push('flush'); return true; });
    const landLocal = t.mock.fn(async () => { order.push('local'); return landedSource; });
    const landRemote = t.mock.fn(async () => { order.push('land-ipc'); return reply; });
    const statusRemote = t.mock.fn(async () => { order.push('status-ipc'); return { success: true }; });
    const visible = activeProjectId === 'original' && !staleSource
        ? source : { ...clone(source), config: { prompt: 'visible node with the same ID' } };
    const manager = Object.assign(Object.create(CanvasManager.prototype), {
        storeData: { activeGroupId: activeProjectId }, items: new Map([[source.id, { data: visible }]]),
        options: { flushBoard: flush }, _landResult: landLocal,
        emit: t.mock.fn(), _scheduleSelectionToolbarSync: t.mock.fn()
    });
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    globalThis.window = { flowCanvas: { mcp: { landGenerationResult: landRemote, updateGenerationNodeStatus: statusRemote } } };
    t.after(() => {
        if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
        else delete globalThis.window;
    });
    return { manager, source, context, output, landedSource, reply, visible, order, flush, landLocal, landRemote, statusRemote };
}

test('the current project and live source object land locally and await card creation', async t => {
    const h = harness(t);
    const gate = deferred();
    h.landLocal.mock.mockImplementation(() => gate.promise);
    const pending = h.manager._landRunResult(h.source, h.output, h.context);
    assert.equal(h.landLocal.mock.callCount(), 1);
    assert.strictEqual(firstArgs(h.landLocal)[0], h.source);
    assert.strictEqual(firstArgs(h.landLocal)[1], h.output);
    assert.equal(h.flush.mock.callCount(), 0);
    assert.equal(h.landRemote.mock.callCount(), 0);
    gate.resolve(h.landedSource);
    assert.strictEqual(await pending, h.landedSource);
});

test('offscreen results flush first, target the captured project, and update the stale runner object', async t => {
    const h = harness(t, { activeProjectId: 'other' });
    const expectedBefore = clone(h.context.expectedNode);
    const visibleBefore = clone(h.visible);
    const gate = deferred();
    h.flush.mock.mockImplementation(() => { h.order.push('flush'); return gate.promise; });
    const pending = h.manager._landRunResult(h.source, h.output, h.context);
    assert.equal(h.landRemote.mock.callCount(), 0);
    gate.resolve(true);
    const result = await pending;
    assert.strictEqual(result, h.reply);
    assert.deepEqual(h.order, ['flush', 'land-ipc']);
    assert.equal(h.landLocal.mock.callCount(), 0);
    assert.deepEqual(firstArgs(h.landRemote)[0], {
        projectId: 'original', nodeId: 'source', expectedNode: expectedBefore, output: h.output,
        operationId: JSON.stringify(['original', 'source', '/one.png'])
    });
    assert.deepEqual(h.source, h.reply.sourceNode);
    assert.equal(Object.hasOwn(h.source, 'nodeType'), false);
    assert.equal(Object.hasOwn(h.source, 'config'), false);
    assert.deepEqual(h.context.expectedNode, expectedBefore);
    assert.deepEqual(h.visible, visibleBefore);
    assert.equal(h.manager.storeData.activeGroupId, 'other');
});

test('switching back to the same project still uses IPC when the runner owns a stale source object', async t => {
    const h = harness(t, { staleSource: true });
    const visibleBefore = clone(h.visible);
    await h.manager._landRunResult(h.source, h.output, h.context);
    assert.equal(h.landLocal.mock.callCount(), 0);
    assert.equal(h.landRemote.mock.callCount(), 1);
    assert.deepEqual(h.visible, visibleBefore);
});

test('an in-project config edit blocks landing without flush, IPC, or overwriting the edit', async t => {
    const h = harness(t);
    h.source.config.prompt = 'manual edit';
    const before = clone(h.source);
    await assert.rejects(h.manager._landRunResult(h.source, h.output, h.context), /\u8282\u70b9\u5df2\u4fee\u6539/);
    assert.deepEqual(h.source, before);
    assert.equal(h.landLocal.mock.callCount(), 0);
    assert.equal(h.flush.mock.callCount(), 0);
    assert.equal(h.landRemote.mock.callCount(), 0);
});

test('geometry, status, thumbnail bookkeeping and preview dimensions do not block current-project landing', async t => {
    const h = harness(t);
    h.source.x = -500;
    h.source.y = 880;
    h.source.runStatus = 'queued';
    h.source.runError = 'transient error';
    h.source.runStartedAt = 9876;
    h.source._previewToken = 3;
    h.source._previewImage = { loaded: true };
    h.source.generatorUiVersion = 1;
    h.manager._storeResolvedMediaSize(h.manager.items.get(h.source.id), 512, 256);
    setGeneratorResultLayout(h.source, 'branched');
    assert.equal(generationNodeSignature(h.source), generationNodeSignature(h.context.expectedNode));
    assert.strictEqual(await h.manager._landRunResult(h.source, h.output, h.context), h.landedSource);
    assert.equal(h.landLocal.mock.callCount(), 1);
    assert.equal(h.landRemote.mock.callCount(), 0);
});

test('cancellation while flush is pending prevents generation landing IPC', async t => {
    const h = harness(t, { activeProjectId: 'other' });
    const before = clone(h.source);
    const gate = deferred();
    h.flush.mock.mockImplementation(() => gate.promise);
    const pending = h.manager._landRunResult(h.source, h.output, h.context);
    assert.equal(h.flush.mock.callCount(), 1);
    h.context.runState.canceled = true;
    gate.resolve(true);
    await assert.rejects(pending, { code: 'GENERATION_CANCELED' });
    assert.equal(h.landRemote.mock.callCount(), 0);
    assert.equal(h.landLocal.mock.callCount(), 0);
    assert.deepEqual(h.source, before);
});

for (const activeProjectId of ['original', 'other']) {
    test(`already-canceled runs do not land or flush in ${activeProjectId}`, async t => {
        const h = harness(t, { activeProjectId });
        h.context.runState.canceled = true;
        await assert.rejects(h.manager._landRunResult(h.source, h.output, h.context), { code: 'GENERATION_CANCELED' });
        assert.equal(h.landLocal.mock.callCount(), 0);
        assert.equal(h.landRemote.mock.callCount(), 0);
        assert.equal(h.flush.mock.callCount(), 0);
    });
}

for (const failure of ['conflict', 'rejection']) {
    test(`a flush ${failure} prevents landing and status IPC`, async t => {
        const h = harness(t, { activeProjectId: 'other' });
        h.flush.mock.mockImplementation(async () => {
            if (failure === 'rejection') throw new Error('flush failed');
            return false;
        });
        await assert.rejects(h.manager._landRunResult(h.source, h.output, h.context));
        await assert.rejects(h.manager._persistRunStatus(h.source, h.context));
        assert.equal(h.landRemote.mock.callCount(), 0);
        assert.equal(h.statusRemote.mock.callCount(), 0);
        assert.equal(h.landLocal.mock.callCount(), 0);
    });
}

for (const failure of ['empty result', 'rejection']) {
    test(`local landing ${failure} is not reported as success`, async t => {
        const h = harness(t);
        h.landLocal.mock.mockImplementation(async () => {
            if (failure === 'rejection') throw new Error('card creation failed');
            return null;
        });
        await assert.rejects(h.manager._landRunResult(h.source, h.output, h.context));
        assert.equal(h.landRemote.mock.callCount(), 0);
    });
}

for (const [name, reply] of [
    ['explicit failure', { success: false, error: 'SOURCE_CHANGED', sourceNode: { id: 'must-not-replace' } }],
    ['missing reply', undefined],
    ['empty reply', {}],
    ['missing success flag', { sourceNode: { id: 'must-not-replace' } }]
]) {
    test(`landing IPC ${name} rejects and preserves the stale runner source`, async t => {
        const h = harness(t, { activeProjectId: 'other' });
        const before = clone(h.source);
        h.landRemote.mock.mockImplementation(async () => reply);
        await assert.rejects(h.manager._landRunResult(h.source, h.output, h.context),
            reply?.error ? { message: reply.error } : Error);
        assert.deepEqual(h.source, before);
        assert.equal(h.landLocal.mock.callCount(), 0);
    });
}

test('landing IPC rejection propagates without replacing the source', async t => {
    const h = harness(t, { activeProjectId: 'other' });
    const before = clone(h.source);
    const error = new Error('IPC disconnected');
    h.landRemote.mock.mockImplementation(async () => { throw error; });
    await assert.rejects(h.manager._landRunResult(h.source, h.output, h.context), candidate => candidate === error);
    assert.deepEqual(h.source, before);
});

test('an unavailable landing bridge or missing original project is not a successful no-op', async t => {
    const h = harness(t, { activeProjectId: 'other' });
    await assert.rejects(h.manager._landRunResult(h.source, h.output, { ...h.context, projectId: null }));
    delete window.flowCanvas.mcp.landGenerationResult;
    await assert.rejects(h.manager._landRunResult(h.source, h.output, h.context));
    assert.equal(h.flush.mock.callCount(), 0);
    assert.equal(h.landLocal.mock.callCount(), 0);
});

test('a text-only output does not enter generation landing', async t => {
    const h = harness(t, { activeProjectId: 'other' });
    assert.equal(await h.manager._landRunResult(h.source, { text: 'generated text' }, h.context), null);
    assert.equal(h.landRemote.mock.callCount(), 0);
    assert.equal(h.landLocal.mock.callCount(), 0);
    assert.equal(h.flush.mock.callCount(), 0);
});

for (const status of ['error', 'canceled']) {
    test(`offscreen ${status} status flushes and targets the original project with its expected snapshot`, async t => {
        const h = harness(t, { activeProjectId: 'other' });
        h.source.runStatus = status;
        h.source.runError = 'terminal reason';
        const before = clone(h.source);
        const visibleBefore = clone(h.visible);
        const gate = deferred();
        h.flush.mock.mockImplementation(() => { h.order.push('flush'); return gate.promise; });
        const pending = h.manager._persistRunStatus(h.source, h.context);
        assert.equal(h.statusRemote.mock.callCount(), 0);
        gate.resolve(true);
        await pending;
        assert.deepEqual(h.order, ['flush', 'status-ipc']);
        assert.deepEqual(firstArgs(h.statusRemote)[0], {
            projectId: 'original', nodeId: 'source', expectedNode: h.context.expectedNode,
            status, error: 'terminal reason', operationId: h.context.operationId
        });
        assert.equal(h.manager.emit.mock.callCount(), 0);
        assert.deepEqual(h.source, before);
        assert.deepEqual(h.visible, visibleBefore);
    });
}

test('current-project status emits a change without a flush or IPC', async t => {
    const h = harness(t);
    await h.manager._persistRunStatus(h.source, h.context);
    assert.deepEqual(firstArgs(h.manager.emit), ['change']);
    assert.equal(h.flush.mock.callCount(), 0);
    assert.equal(h.statusRemote.mock.callCount(), 0);
});

test('status from a stale source in the current project still uses the authoritative IPC writer', async t => {
    const h = harness(t, { staleSource: true });
    await h.manager._persistRunStatus(h.source, h.context);
    assert.equal(h.statusRemote.mock.callCount(), 1);
    assert.equal(h.manager.emit.mock.callCount(), 0);
});

for (const failure of ['explicit failure', 'rejection']) {
    test(`status IPC ${failure} is surfaced to the caller`, async t => {
        const h = harness(t, { activeProjectId: 'other' });
        h.statusRemote.mock.mockImplementation(async () => {
            if (failure === 'rejection') throw new Error('status write failed');
            return { success: false, error: 'status write failed' };
        });
        await assert.rejects(h.manager._persistRunStatus(h.source, h.context), { message: 'status write failed' });
        assert.equal(h.manager.emit.mock.callCount(), 0);
    });
}

test('empty status acknowledgements cannot silently pass persistence', async t => {
    const h = harness(t, { activeProjectId: 'other' });
    for (const result of [undefined, {}]) {
        h.statusRemote.mock.mockImplementation(async () => result);
        await assert.rejects(h.manager._persistRunStatus(h.source, h.context), /状态保存失败/);
    }
});

test('cycling a stack candidate changes the signature and active upstream output, blocking an in-flight landing', async t => {
    const h = harness(t);
    appendGeneratorResult(h.source, { filePath: '/old-one.png' });
    appendGeneratorResult(h.source, { filePath: '/old-two.png' });
    h.context.expectedNode = clone(h.source);
    const beforeOutput = generatorResultOutput(h.source);
    const beforePaths = [...h.source.resultFilePaths].sort();
    rotateGeneratorResults(h.source);
    assert.deepEqual([...h.source.resultFilePaths].sort(), beforePaths);
    assert.notEqual(generationNodeSignature(h.source), generationNodeSignature(h.context.expectedNode));
    assert.notDeepEqual(generatorResultOutput(h.source), beforeOutput);
    await assert.rejects(h.manager._landRunResult(h.source, h.output, h.context), /\u8282\u70b9\u5df2\u4fee\u6539/);
    assert.equal(h.landLocal.mock.callCount(), 0);
});
