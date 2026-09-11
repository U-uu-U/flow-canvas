const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Ajv = require('ajv');

const copy = value => JSON.parse(JSON.stringify(value));
const toolId = (id, name) => `external_mcp_${crypto.createHash('sha256').update(`${id}:${name}`).digest('hex').slice(0, 32)}`;

function normalize(input, previous = {}) {
    const config = { ...previous, ...input, id: previous.id || crypto.randomUUID() };
    config.name = String(config.name || '').trim();
    if (!config.name || config.name.length > 100) throw new Error('请填写 MCP 名称（最多 100 字）');
    if (!['stdio', 'http', 'sse'].includes(config.transport)) throw new Error('不支持的 MCP 传输类型');
    config.enabled = config.enabled === true;
    config.timeoutMs = Math.min(300000, Math.max(1000, Number(config.timeoutMs) || 60000));
    for (const field of ['env', 'headers']) {
        config[field] ??= {};
        if (!config[field] || Array.isArray(config[field]) || typeof config[field] !== 'object'
            || Object.values(config[field]).some(value => typeof value !== 'string')) throw new Error(`${field} 必须是字符串键值对象`);
    }
    if (config.transport === 'stdio') {
        if (typeof config.command !== 'string' || !config.command.trim()) throw new Error('请填写可执行程序路径或命令');
        config.args ??= [];
        if (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string')) throw new Error('args 必须是字符串数组');
        if (config.cwd && !path.isAbsolute(config.cwd)) throw new Error('工作目录必须是绝对路径');
    } else {
        const url = new URL(config.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请使用 HTTP(S) 地址，认证信息放入 headers');
        config.url = url.href;
    }
    return { id: config.id, name: config.name, enabled: config.enabled, transport: config.transport,
        command: config.command || '', args: config.args || [], cwd: config.cwd || '', url: config.url || '',
        env: config.env, headers: config.headers, timeoutMs: config.timeoutMs };
}

async function openConnection(config, { signal } = {}) {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const client = new Client({ name: 'flow-canvas', version: '1.5.0' });
    let transport;
    if (config.transport === 'stdio') {
        const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
        transport = new StdioClientTransport({ command: config.command, args: config.args,
            cwd: config.cwd || undefined, env: { ...getDefaultEnvironment(), ...config.env }, stderr: 'pipe' });
    } else if (config.transport === 'http') {
        const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
        transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    } else {
        const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
        transport = new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers },
            eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...init?.headers, ...config.headers } }) } });
    }
    transport.stderr?.on('data', () => {});
    let interrupt;
    const interrupted = new Promise((_, reject) => { interrupt = reject; });
    const abort = () => interrupt(new Error('MCP 连接已取消'));
    const timer = setTimeout(() => interrupt(new Error('MCP 初始化超时')), config.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    try {
        if (signal?.aborted) throw new Error('MCP 连接已取消');
        await Promise.race([client.connect(transport, { timeout: config.timeoutMs, signal }), interrupted]);
    } catch (error) { await client.close().catch(() => {}); throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    return client;
}

class McpClientManager {
    constructor({ directory, safeStorage, connect = openConnection }) {
        this.file = path.join(directory, 'mcp-clients.json');
        this.safeStorage = safeStorage;
        this.open = connect;
        this.connections = new Map();
        this.connecting = new Map();
        this.openingControllers = new Map();
        this.queues = new Map();
        this.errors = new Map();
        this.tools = new Map();
        this.configs = [];
        this.epoch = new Map();
        this.closed = false;
        this.loadError = '';
        try {
            const payload = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            const configs = JSON.parse(safeStorage.decryptString(Buffer.from(payload.encrypted, 'base64')));
            if (!Array.isArray(configs) || configs.some(c => !c || typeof c.id !== 'string' || !c.id)
                || new Set(configs.map(c => c.id)).size !== configs.length) throw new Error('Invalid MCP configuration');
            this.configs = configs.map(c => normalize(c, c));
        } catch (error) {
            if (error.code !== 'ENOENT') this.loadError = 'MCP 配置无法解密或已损坏，原文件已保留';
        }
    }
    persist() {
        if (this.loadError) throw new Error(this.loadError);
        if (!this.safeStorage?.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，未保存 MCP 配置');
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const encrypted = this.safeStorage.encryptString(JSON.stringify(this.configs)).toString('base64');
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, encrypted }), { mode: 0o600 });
        fs.renameSync(`${this.file}.tmp`, this.file);
    }
    secrets() {
        return this.configs.flatMap(c => [...Object.values(c.env), ...Object.values(c.headers), c.url].filter(Boolean));
    }
    redact(message) {
        let text = String(message || '');
        for (const secret of this.secrets()) text = text.split(secret).join('[redacted]');
        return text.slice(0, 2000);
    }
    list() {
        return { error: this.loadError, servers: this.configs.map(config => {
            const { env, headers, ...visible } = config;
            return { ...visible, hasEnv: Object.keys(env).length > 0, hasHeaders: Object.keys(headers).length > 0,
                status: this.connecting.has(config.id) ? 'connecting' : this.connections.has(config.id) ? 'connected' : 'disconnected',
                error: this.errors.get(config.id) || '',
                tools: [...this.tools.values()].filter(t => t.serverId === config.id)
                    .map(t => ({ name: t.remoteName, description: t.description, inputSchema: t.inputSchema, readOnly: t.readOnly })) };
        }) };
    }
    async save(input) {
        const index = this.configs.findIndex(c => c.id === input.id);
        if (input.id && index < 0) throw new Error('MCP 配置不存在');
        const config = normalize(input, index < 0 ? {} : this.configs[index]);
        const previous = this.configs;
        this.configs = index < 0 ? [...previous, config] : previous.map(c => c.id === config.id ? config : c);
        try { this.persist(); } catch (error) { this.configs = previous; throw error; }
        await this.disconnect(config.id);
        this.errors.delete(config.id);
        return this.list();
    }
    async remove({ id }) {
        const previous = this.configs;
        this.configs = previous.filter(c => c.id !== id);
        try { this.persist(); } catch (error) { this.configs = previous; throw error; }
        await this.disconnect(id);
        return this.list();
    }
    async disconnect(id) {
        this.epoch.set(id, (this.epoch.get(id) || 0) + 1);
        this.openingControllers.get(id)?.abort();
        const client = this.connections.get(id);
        this.connections.delete(id);
        for (const [name, tool] of this.tools) if (tool.serverId === id) this.tools.delete(name);
        await client?.close().catch(() => {});
        await this.connecting.get(id)?.catch(() => {});
    }
    async connect(id) {
        if (this.closed) throw new Error('MCP 客户端已关闭');
        if (this.connections.has(id)) return;
        if (this.connecting.has(id)) return this.connecting.get(id);
        const config = this.configs.find(c => c.id === id);
        if (!config?.enabled) throw new Error('请先启用该 MCP 服务');
        const epoch = this.epoch.get(id) || 0;
        const controller = new AbortController();
        this.openingControllers.set(id, controller);
        const pending = (async () => {
            let client;
            try {
                client = await this.open(config, { signal: controller.signal });
                const discovered = [];
                const seen = new Set();
                let cursor;
                do {
                    const result = await client.listTools(cursor ? { cursor } : {}, { timeout: config.timeoutMs, signal: controller.signal });
                    discovered.push(...result.tools);
                    if (discovered.length > 512 || (result.nextCursor && seen.has(result.nextCursor))) throw new Error('MCP 工具列表超过限制或分页循环');
                    cursor = result.nextCursor;
                    seen.add(cursor);
                } while (cursor);
                if (this.closed || epoch !== (this.epoch.get(id) || 0)) throw new Error('MCP 配置已变更，请重新连接');
                const ajv = new Ajv({ allErrors: true, schemaId: 'auto' });
                const entries = discovered.map(tool => {
                    const schema = copy(tool.inputSchema);
                    // Most MCP schemas use the common object subset; reject unsupported schemas instead of skipping validation.
                    return { name: toolId(id, tool.name), serverId: id, remoteName: tool.name,
                        description: `[${config.name}] ${tool.description || tool.name}`.slice(0, 4000),
                        inputSchema: schema, validate: ajv.compile(schema), readOnly: tool.annotations?.readOnlyHint === true, epoch,
                        binding: crypto.createHash('sha256').update(JSON.stringify({ config, schema })).digest('hex') };
                });
                for (const entry of entries) this.tools.set(entry.name, entry);
                this.connections.set(id, client);
                client.onclose = () => {
                    if (this.connections.get(id) !== client) return;
                    this.connections.delete(id);
                    for (const [name, tool] of this.tools) if (tool.serverId === id) this.tools.delete(name);
                    this.errors.set(id, 'MCP 连接已断开，请重新测试连接');
                };
                this.errors.delete(id);
            } catch (error) {
                await client?.close().catch(() => {});
                this.errors.set(id, this.redact(error.message));
                throw new Error(this.redact(error.message));
            }
        })();
        this.connecting.set(id, pending);
        try { await pending; } finally { this.connecting.delete(id); this.openingControllers.delete(id); }
    }
    async test({ id }) {
        await this.disconnect(id);
        await this.connect(id);
        return this.list();
    }
    async ready() {
        for (const config of this.configs) if (config.enabled && !this.errors.has(config.id)) {
            try { await this.connect(config.id); } catch { /* Other servers and built-in tools remain available. */ }
        }
    }
    definitions() { return [...this.tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })); }
    isExternal(name) { return String(name).startsWith('external_mcp_'); }
    isReadOnly(name) { return this.tools.get(name)?.readOnly === true; }
    binding(name) { return this.tools.get(name)?.binding; }
    async call(name, args, { signal, onDispatch = () => {} } = {}) {
        const tool = this.tools.get(name);
        if (!tool) throw new Error('外部 MCP 工具不可用，请检查连接');
        if (!tool.validate(args)) throw new Error(`MCP 参数无效：${JSON.stringify(tool.validate.errors)}`);
        const work = (this.queues.get(tool.serverId) || Promise.resolve()).then(async () => {
            if (signal?.aborted) throw new Error('已取消');
            const client = this.connections.get(tool.serverId);
            if (!client || this.tools.get(name) !== tool) throw new Error('MCP 连接或工具已变更，请重试');
            const config = this.configs.find(c => c.id === tool.serverId);
            onDispatch();
            try {
                return await client.callTool({ name: tool.remoteName, arguments: args }, undefined,
                    { signal, timeout: config.timeoutMs, maxTotalTimeout: config.timeoutMs });
            } catch (error) {
                const failure = new Error(`MCP 调用未取得确定结果，请先检查外部软件状态，不要直接重发。${this.redact(error.message)}`);
                failure.code = 'MCP_RESULT_UNKNOWN';
                throw failure;
            }
        });
        this.queues.set(tool.serverId, work.catch(() => {}));
        return work;
    }
    async close() {
        this.closed = true;
        for (const config of this.configs) await this.disconnect(config.id);
        await Promise.allSettled(this.connecting.values());
    }
}

module.exports = { McpClientManager, normalize, toolId };
