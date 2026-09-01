const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('stdio MCP exposes and calls the shared board transaction tools', async (t) => {
    const bridgeRequests = [];
    const bridge = http.createServer(async (req, res) => {
        const body = await readJson(req);
        bridgeRequests.push({ method: req.method, path: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            snapshot: {
                schema: 'flow-canvas.board-snapshot.v1',
                revision: 7,
                scope: body.scope
            }
        }));
    });
    await listen(bridge);
    t.after(() => closeServer(bridge));

    const address = bridge.address();
    const child = spawn(process.execPath, [path.join(__dirname, 'flow-canvas-mcp.mjs')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            FLOW_CANVAS_BRIDGE_URL: `http://127.0.0.1:${address.port}`
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    const client = createMcpClient(child);
    t.after(() => {
        child.stdin.end();
        if (!child.killed) child.kill();
    });

    const initialized = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'flow-canvas-test-harness', version: '1.0.0' }
    });
    assert.equal(initialized.result.serverInfo.name, 'flow-canvas-mcp');

    const listed = await client.request('tools/list', {});
    const names = listed.result.tools.map(tool => tool.name);
    assert.ok(names.includes('flow_canvas.board.get_snapshot'));
    assert.ok(names.includes('flow_canvas.board.transaction.preview'));
    assert.ok(names.includes('flow_canvas.board.transaction.apply'));
    assert.ok(names.includes('flow_canvas.board.transaction.undo'));

    const called = await client.request('tools/call', {
        name: 'flow_canvas.board.get_snapshot',
        arguments: { scope: 'project' }
    });
    const result = JSON.parse(called.result.content[0].text);
    assert.equal(result.snapshot.revision, 7);
    assert.deepEqual(bridgeRequests, [{
        method: 'POST',
        path: '/board/snapshot',
        body: { scope: 'project' }
    }]);
});

test('stdio MCP preserves structured Flow Canvas bridge errors', async (t) => {
    const bridge = http.createServer((_req, res) => {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            error: 'revision changed',
            code: 'REVISION_CONFLICT',
            details: { expectedRevision: 7, actualRevision: 8 }
        }));
    });
    await listen(bridge);
    t.after(() => closeServer(bridge));

    const child = spawn(process.execPath, [path.join(__dirname, 'flow-canvas-mcp.mjs')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            FLOW_CANVAS_BRIDGE_URL: `http://127.0.0.1:${bridge.address().port}`
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    const client = createMcpClient(child);
    t.after(() => {
        child.stdin.end();
        if (!child.killed) child.kill();
    });

    const response = await client.request('tools/call', {
        name: 'flow_canvas.board.transaction.apply',
        arguments: { id: 'tx', baseRevision: 7, operations: [{ op: 'node.delete', nodeId: 'a' }] }
    });
    assert.equal(response.error.code, -32000);
    assert.equal(response.error.data.status, 409);
    assert.equal(response.error.data.code, 'REVISION_CONFLICT');
    assert.equal(response.error.data.details.actualRevision, 8);
});

function createMcpClient(child) {
    let nextId = 1;
    let buffer = Buffer.alloc(0);
    const pending = new Map();
    let stderr = '';

    child.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd < 0) return;
            const header = buffer.slice(0, headerEnd).toString('utf8');
            const match = header.match(/Content-Length:\s*(\d+)/i);
            if (!match) throw new Error(`Invalid MCP header: ${header}`);
            const length = Number(match[1]);
            const bodyStart = headerEnd + 4;
            const bodyEnd = bodyStart + length;
            if (buffer.length < bodyEnd) return;
            const message = JSON.parse(buffer.slice(bodyStart, bodyEnd).toString('utf8'));
            buffer = buffer.slice(bodyEnd);
            const waiter = pending.get(message.id);
            if (!waiter) continue;
            pending.delete(message.id);
            clearTimeout(waiter.timer);
            waiter.resolve(message);
        }
    });
    child.once('exit', code => {
        for (const waiter of pending.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error(`MCP process exited with ${code}: ${stderr}`));
        }
        pending.clear();
    });

    return {
        request(method, params) {
            const id = nextId++;
            const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
            const response = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`MCP request timed out: ${method}; stderr: ${stderr}`));
                }, 10_000);
                pending.set(id, { resolve, reject, timer });
            });
            child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
            child.stdin.write(payload);
            return response;
        }
    };
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
}

function closeServer(server) {
    return new Promise(resolve => server.close(resolve));
}
