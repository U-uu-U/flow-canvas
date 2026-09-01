const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const FlowCanvasBridge = require('./mcp-bridge');

function createBridge(options = {}) {
    const requests = [];
    const webContents = {
        isDestroyed: () => false,
        send: (_channel, payload) => requests.push(payload)
    };
    const mainWindow = {
        isDestroyed: () => false,
        webContents
    };
    const bridge = new FlowCanvasBridge({
        store: {
            load: () => ({ folderGroups: [], mcp: {} }),
            save: () => true
        },
        getMainWindow: () => mainWindow,
        boardToolRequestTimeoutMs: options.timeoutMs || 100
    });
    return { bridge, requests };
}

function nextTurn() {
    return new Promise(resolve => setImmediate(resolve));
}

test('board tool requests require a ready renderer and preserve structured errors', async () => {
    const { bridge, requests } = createBridge();
    await assert.rejects(
        bridge._requestBoardTool('flow_canvas.board.get_snapshot', {}),
        error => error.code === 'RENDERER_NOT_READY' && error.status === 503
    );

    bridge.setBoardToolsReady(true);
    const pending = bridge._requestBoardTool('flow_canvas.board.get_snapshot', { scope: 'selection' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].toolName, 'flow_canvas.board.get_snapshot');
    bridge.handleBoardToolResponse({
        requestId: requests[0].requestId,
        success: false,
        error: {
            code: 'REVISION_CONFLICT',
            message: 'revision changed',
            details: { expectedRevision: 3, actualRevision: 4 }
        }
    });
    await assert.rejects(
        pending,
        error => error.code === 'REVISION_CONFLICT'
            && error.status === 409
            && error.details.actualRevision === 4
    );
});

test('renderer refresh rejects pending requests and late responses are ignored', async () => {
    const { bridge, requests } = createBridge();
    bridge.setBoardToolsReady(true);
    const pending = bridge._requestBoardTool('flow_canvas.board.transaction.preview', { id: 'tx' });
    bridge.setBoardToolsReady(false, {
        code: 'RENDERER_RELOADING',
        message: 'renderer reloading'
    });
    await assert.rejects(pending, error => error.code === 'RENDERER_RELOADING');
    assert.equal(bridge.handleBoardToolResponse({
        requestId: requests[0].requestId,
        success: true,
        result: {}
    }), false);
});

test('board tool request timeout clears the pending request', async () => {
    const { bridge } = createBridge({ timeoutMs: 20 });
    bridge.setBoardToolsReady(true);
    await assert.rejects(
        bridge._requestBoardTool('flow_canvas.board.get_snapshot', {}),
        error => error.code === 'BOARD_TOOL_TIMEOUT' && error.status === 504
    );
    assert.equal(bridge.pendingBoardToolRequests.size, 0);
});

test('generation cancellation aborts active work and catches pre-registration races', async () => {
    const { bridge } = createBridge();
    let releaseActive;
    const active = bridge._runCancelableGeneration('task-active', signal => new Promise(resolve => {
        releaseActive = resolve;
        signal.addEventListener('abort', () => resolve('late result'), { once: true });
    }));
    await nextTurn();
    assert.deepEqual(bridge.cancelGenerationFromRenderer('task-active'), {
        canceled: true,
        active: true
    });
    await assert.rejects(active, error => error.code === 'GENERATION_CANCELED');
    releaseActive?.('unused');

    assert.deepEqual(bridge.cancelGenerationFromRenderer('task-before-start'), {
        canceled: true,
        active: false
    });
    await assert.rejects(
        bridge._runCancelableGeneration('task-before-start', async () => 'should not run'),
        error => error.code === 'GENERATION_CANCELED'
    );
});

test('apply and undo routes are serialized through the mutation queue', async () => {
    const { bridge, requests } = createBridge();
    bridge.setBoardToolsReady(true);
    const route = bridge._matchRoute('POST', '/board/transactions/apply');
    const first = route.handler({}, { id: 'tx-1' });
    const second = route.handler({}, { id: 'tx-2' });

    await nextTurn();
    assert.deepEqual(requests.map(request => request.input.id), ['tx-1']);
    bridge.handleBoardToolResponse({
        requestId: requests[0].requestId,
        success: true,
        result: { transactionId: 'tx-1' }
    });

    await nextTurn();
    assert.deepEqual(requests.map(request => request.input.id), ['tx-1', 'tx-2']);
    bridge.handleBoardToolResponse({
        requestId: requests[1].requestId,
        success: true,
        result: { transactionId: 'tx-2' }
    });
    assert.deepEqual(await Promise.all([first, second]), [
        { transactionId: 'tx-1' },
        { transactionId: 'tx-2' }
    ]);
});

test('HTTP bridge returns 403 when a board tool is not allowed', async () => {
    const port = await getFreePort();
    const { bridge } = createBridge();
    bridge.start({ enabled: true, host: '127.0.0.1', port, allowedTools: [] });
    await waitForListening(bridge.server);
    try {
        const response = await fetch(`http://127.0.0.1:${port}/board/snapshot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const payload = await response.json();
        assert.equal(response.status, 403);
        assert.match(payload.error, /not allowed/);
    } finally {
        bridge.stop();
    }
});

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

function waitForListening(server) {
    if (server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
}
