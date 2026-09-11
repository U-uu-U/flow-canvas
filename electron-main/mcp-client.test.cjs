const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { McpClientManager, normalize, toolId } = require('./mcp-client.cjs');

const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
const definition = { name: 'scene.inspect', inputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] } };
function setup(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-mcp-client-'));
    const manager = new McpClientManager({ directory, safeStorage, ...options });
    t.after(async () => { await manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return { manager, directory };
}
async function add(manager, extra = {}) {
    const result = await manager.save({ name: 'Test server', transport: 'stdio', command: process.execPath, enabled: true, ...extra });
    return result.servers.at(-1).id;
}
const mock = (overrides = {}) => ({ listTools: async () => ({ tools: [definition] }), close: async () => {},
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }), ...overrides });

test('encrypted config survives reload without exposing env/headers in settings', async t => {
    const { manager, directory } = setup(t);
    const id = await add(manager, { env: { TOKEN: 'private-test-key' }, headers: { Authorization: 'Bearer test-secret' } });
    assert.equal(JSON.stringify(manager.list()).includes('private-test-key'), false);
    assert.equal(fs.readFileSync(manager.file, 'utf8').includes('private-test-key'), false);
    await manager.save({ id, name: 'Renamed' });
    const restored = new McpClientManager({ directory, safeStorage });
    assert.equal(restored.configs[0].env.TOKEN, 'private-test-key');
    assert.equal(restored.configs[0].name, 'Renamed');
    await restored.close();
    await manager.save({ id, env: {}, headers: {} });
    assert.equal(manager.list().servers[0].hasEnv, false);
});

test('failed encryption/corrupt data cannot overwrite original configuration', async t => {
    const { manager, directory } = setup(t, { safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } });
    await assert.rejects(add(manager), /加密/);
    assert.equal(manager.configs.length, 0);
    fs.writeFileSync(manager.file, 'corrupt');
    const restored = new McpClientManager({ directory, safeStorage });
    await assert.rejects(add(restored), /损坏/);
    assert.equal(fs.readFileSync(manager.file, 'utf8'), 'corrupt');
});

test('configuration validation and namespacing', () => {
    assert.throws(() => normalize({ name: 'x', transport: 'http', url: 'file:///x' }));
    assert.throws(() => normalize({ name: 'x', transport: 'stdio', command: 'node', args: '--flag' }));
    assert.throws(() => normalize({ name: 'x', transport: 'stdio', command: 'node', env: { x: 1 } }));
    assert.notEqual(toolId('a', 'same.tool'), toolId('b', 'same.tool'));
    assert.match(toolId('a', 'same.tool'), /^[a-zA-Z0-9_]{1,64}$/);
});

test('tool discovery paginates, deduplicates connections, validates calls, and disables tools', async t => {
    let opened = 0; let called = 0;
    const { manager } = setup(t, { connect: async () => {
        opened++;
        return mock({ listTools: async ({ cursor }) => cursor ? { tools: [{ ...definition, name: 'other' }] }
            : { tools: [definition], nextCursor: 'next' }, callTool: async () => { called++; return { content: [] }; } });
    } });
    const id = await add(manager);
    await Promise.all([manager.connect(id), manager.connect(id)]);
    assert.equal(opened, 1); assert.equal(manager.definitions().length, 2);
    await assert.rejects(manager.call(toolId(id, definition.name), { count: 0 }), /参数/);
    assert.equal(called, 0);
    await manager.call(toolId(id, definition.name), { count: 1 });
    assert.equal(called, 1);
    await manager.save({ id, enabled: false });
    assert.equal(manager.definitions().length, 0);
    await assert.rejects(manager.connect(id), /启用/);
});

test('scene calls are serialized and queued cancellation never dispatches', async t => {
    let finish; let calls = 0;
    const { manager } = setup(t, { connect: async () => mock({ callTool: async () => {
        calls++; await new Promise(resolve => { finish = resolve; }); return { content: [] };
    } }) });
    const id = await add(manager); await manager.connect(id);
    const first = manager.call(toolId(id, definition.name), { count: 1 });
    await new Promise(resolve => setImmediate(resolve));
    const controller = new AbortController();
    const second = manager.call(toolId(id, definition.name), { count: 2 }, { signal: controller.signal });
    const rejected = assert.rejects(second, /取消/);
    controller.abort(); finish(); await first; await rejected;
    assert.equal(calls, 1);
});

test('connection change invalidates queued operations', async t => {
    let finish;
    const { manager } = setup(t, { connect: async () => mock({ callTool: () => new Promise(resolve => { finish = resolve; }) }) });
    const id = await add(manager); await manager.connect(id);
    const first = manager.call(toolId(id, definition.name), { count: 1 });
    await new Promise(resolve => setImmediate(resolve));
    const second = manager.call(toolId(id, definition.name), { count: 2 });
    const rejected = assert.rejects(second, /变更/);
    await manager.save({ id, command: 'different' });
    finish({ content: [] }); await first; await rejected;
});

test('unknown call result is never retried; connection error is redacted', async t => {
    let count = 0;
    const { manager } = setup(t, { connect: async () => mock({ callTool: async () => { count++; throw new Error('secret-value timeout'); } }) });
    const id = await add(manager, { env: { TOKEN: 'secret-value' } }); await manager.connect(id);
    await assert.rejects(manager.call(toolId(id, definition.name), { count: 1 }), error =>
        error.code === 'MCP_RESULT_UNKNOWN' && !error.message.includes('secret-value'));
    assert.equal(count, 1);
});

test('official SDK stdio initializes, lists tools, carries env/cwd and executes real child process', async t => {
    const { manager, directory } = setup(t);
    const id = await add(manager, { args: [path.resolve(__dirname, '../scripts/fixtures/mcp-client-server.cjs')],
        env: { FLOW_MCP_TEST_MARKER: 'fixture-marker' }, cwd: directory });
    await manager.test({ id });
    const result = await manager.call(toolId(id, 'scene.inspect'), { label: 'Rhino/Blender' });
    const scene = JSON.parse(result.content[0].text);
    assert.equal(scene.objectCount, 3); assert.equal(scene.marker, 'fixture-marker');
    assert.equal(fs.realpathSync(scene.cwd), fs.realpathSync(directory));
    assert.equal(manager.isReadOnly(toolId(id, 'scene.inspect')), true);
});

test('shutdown aborts an initializing stdio child instead of waiting for the connection timeout', async t => {
    const { manager } = setup(t);
    const id = await add(manager, { args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 60000 });
    const pending = manager.connect(id);
    const rejected = assert.rejects(pending, /取消/);
    await new Promise(resolve => setTimeout(resolve, 50));
    const start = Date.now();
    await manager.close(); await rejected;
    assert.ok(Date.now() - start < 3000);
    assert.equal(manager.definitions().length, 0);
});

for (const kind of ['http', 'sse']) test(`official SDK ${kind} discovery/call supports authorization headers`, async t => {
    const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
    const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
    const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [definition] }));
    server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: String(request.params.arguments.count) }] }));
    let transport;
    if (kind === 'http') {
        const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'test-session' });
        await server.connect(transport);
    }
    const received = [];
    const listener = http.createServer(async (req, res) => {
        received.push(req.headers.authorization);
        if (req.headers.authorization !== 'Bearer fixture') { res.writeHead(401).end(); return; }
        try {
            if (kind === 'http') await transport.handleRequest(req, res);
            else if (req.method === 'GET') {
                const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
                transport = new SSEServerTransport('/message', res);
                await server.connect(transport);
            } else await transport.handlePostMessage(req, res);
        } catch { if (!res.headersSent) res.writeHead(500).end(); }
    });
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await server.close(); listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); });
    const { manager } = setup(t);
    const id = await add(manager, { transport: kind, url: `http://127.0.0.1:${listener.address().port}/mcp`, headers: { Authorization: 'Bearer fixture' } });
    await manager.connect(id);
    const result = await manager.call(toolId(id, definition.name), { count: 4 });
    assert.equal(result.content[0].text, '4');
    assert.ok(received.length >= 3 && received.every(value => value === 'Bearer fixture'));
    await manager.close();
});
