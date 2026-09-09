import './mcp-client-settings.css';

const icon = name => `<svg class="flow-icon flow-icon-sm" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-${name}"></use></svg>`;

export function mountMcpSettings() {
    const host = document.getElementById('agentApiSettingsPane');
    if (!host || document.getElementById('mcpClientSettings')) return;
    const root = document.createElement('section');
    root.id = 'mcpClientSettings';
    root.className = 'mcp-client-settings';
    root.innerHTML = `
        <div class="agent-settings-section-head"><strong>MCP 外部工具</strong>
            <button type="button" data-action="add" title="添加 MCP 服务" aria-label="添加 MCP 服务">${icon('add')}</button></div>
        <div class="mcp-client-status" role="status" aria-live="polite"></div>
        <div class="mcp-client-list"></div>
        <form class="mcp-client-form" hidden>
            <label>名称<input name="name" class="agent-setting-input" required maxlength="100" placeholder="Rhino / Blender"></label>
            <label>连接方式<select name="transport" class="agent-setting-input"><option value="stdio">本地程序 (stdio)</option><option value="http">Streamable HTTP</option><option value="sse">SSE</option></select></label>
            <label data-stdio>程序<input name="command" class="agent-setting-input" placeholder="uvx / npx / 程序绝对路径"></label>
            <label data-stdio>参数 (JSON 数组)<textarea name="args" class="agent-setting-input" rows="2" placeholder='["blender-mcp"]'></textarea></label>
            <label data-stdio>工作目录<input name="cwd" class="agent-setting-input" placeholder="可选，绝对路径"></label>
            <label data-stdio>环境变量 (JSON)<textarea name="env" class="agent-setting-input mcp-secret" rows="2" autocomplete="off" spellcheck="false" placeholder="{}"></textarea></label>
            <label data-http hidden>服务地址<input name="url" class="agent-setting-input" placeholder="http://127.0.0.1:8000/mcp"></label>
            <label data-http hidden>请求头 (JSON)<textarea name="headers" class="agent-setting-input mcp-secret" rows="2" autocomplete="off" spellcheck="false" placeholder="{}"></textarea></label>
            <label>超时（秒）<input name="timeout" type="number" class="agent-setting-input" min="1" max="300" value="60"></label>
            <label class="mcp-enabled"><input name="enabled" type="checkbox" checked>启用</label>
            <div class="mcp-client-actions"><button type="submit">保存并连接</button><button type="button" data-action="cancel">取消</button></div>
        </form>`;
    host.append(root);
    const api = window.flowCanvas?.mcpClient;
    const status = root.querySelector('[role=status]');
    const list = root.querySelector('.mcp-client-list');
    const form = root.querySelector('form');
    let servers = [];
    let editing = null;
    let busy = false;
    const field = name => form.elements.namedItem(name);
    const message = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
    const transportFields = () => {
        root.querySelectorAll('[data-stdio]').forEach(el => { el.hidden = field('transport').value !== 'stdio'; });
        root.querySelectorAll('[data-http]').forEach(el => { el.hidden = field('transport').value === 'stdio'; });
    };
    const button = (action, symbol, label) => {
        const el = document.createElement('button');
        el.type = 'button'; el.dataset.action = action; el.title = label; el.setAttribute('aria-label', label); el.innerHTML = icon(symbol);
        return el;
    };
    function render(data) {
        servers = data.servers || [];
        list.replaceChildren();
        if (data.error) message(data.error, true);
        for (const server of servers) {
            const row = document.createElement('article');
            row.className = 'mcp-client-row'; row.dataset.id = server.id;
            const heading = document.createElement('div'); heading.className = 'mcp-client-row-head';
            const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = server.enabled;
            enabled.dataset.action = 'toggle'; enabled.setAttribute('aria-label', `启用 ${server.name}`);
            const name = document.createElement('strong'); name.textContent = server.name;
            heading.append(enabled, name, button('test', 'connections', '重新连接并读取工具'), button('edit', 'settings', '编辑连接'), button('remove', 'trash', '删除连接'));
            const state = document.createElement('small');
            state.textContent = `${server.enabled ? ({ connected: '已连接', connecting: '连接中', disconnected: '未连接' }[server.status]) : '已停用'} · ${server.tools.length} 个工具`;
            row.append(heading, state);
            if (server.error) { const error = document.createElement('p'); error.className = 'error'; error.textContent = server.error; row.append(error); }
            if (server.tools.length) {
                const details = document.createElement('details');
                const summary = document.createElement('summary'); summary.textContent = '工具列表'; details.append(summary);
                for (const tool of server.tools) {
                    const entry = document.createElement('div'); entry.className = 'mcp-client-tool';
                    const title = document.createElement('strong'); title.textContent = tool.name;
                    const description = document.createElement('span'); description.textContent = tool.description;
                    entry.append(title, description); details.append(entry);
                }
                row.append(details);
            }
            list.append(row);
        }
        list.querySelectorAll('button, input').forEach(el => { el.disabled = busy; });
    }
    async function perform(work) {
        if (busy) return;
        if (!api) { message('MCP 客户端需要在桌面应用中使用', true); return; }
        busy = true;
        root.querySelectorAll('button, input, select, textarea').forEach(el => { el.disabled = true; });
        try { await work(); }
        catch (error) { message(error.message || String(error), true); }
        finally {
            busy = false;
            root.querySelectorAll('button, input, select, textarea').forEach(el => { el.disabled = false; });
        }
    }
    function edit(server = null) {
        editing = server; form.reset();
        for (const name of ['name', 'transport', 'command', 'cwd', 'url']) field(name).value = server?.[name] || (name === 'transport' ? 'stdio' : '');
        field('args').value = JSON.stringify(server?.args || []);
        field('timeout').value = (server?.timeoutMs || 60000) / 1000;
        field('enabled').checked = server?.enabled ?? true;
        for (const name of ['env', 'headers']) field(name).placeholder = server?.[name === 'env' ? 'hasEnv' : 'hasHeaders'] ? '已保存；留空保留，输入 {} 清空' : '{}';
        form.hidden = false; transportFields(); field('name').focus();
    }
    root.addEventListener('click', event => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (!action || busy) return;
        const server = servers.find(s => s.id === event.target.closest('[data-id]')?.dataset.id);
        if (action === 'add') return edit();
        if (action === 'edit') return edit(server);
        if (action === 'cancel') { form.hidden = true; form.reset(); editing = null; return; }
        if (!server) return;
        void perform(async () => {
            if (action === 'remove') { render(await api.remove({ id: server.id })); message('已删除连接'); }
            if (action === 'toggle') { render(await api.save({ id: server.id, enabled: !server.enabled })); message(server.enabled ? '已停用' : '已启用'); }
            if (action === 'test') {
                message(`正在连接 ${server.name}…`);
                try { render(await api.test({ id: server.id })); message('连接成功，工具已就绪'); }
                catch (error) { render(await api.list()); throw error; }
            }
        });
    });
    field('transport').addEventListener('change', transportFields);
    form.addEventListener('submit', event => {
        event.preventDefault();
        const input = { ...(editing ? { id: editing.id } : {}), enabled: field('enabled').checked,
            timeoutMs: Number(field('timeout').value) * 1000 };
        for (const name of ['name', 'transport', 'command', 'cwd', 'url']) input[name] = field(name).value.trim();
        try {
            input.args = JSON.parse(field('args').value || '[]');
            for (const name of ['env', 'headers']) if (field(name).value.trim()) input[name] = JSON.parse(field(name).value);
        } catch { message('参数、环境变量或请求头不是有效的 JSON', true); return; }
        void perform(async () => {
            message('正在保存…');
            const data = await api.save(input);
            const saved = data.servers.find(s => s.id === editing?.id) || data.servers.at(-1);
            render(data); form.hidden = true; form.reset(); editing = null;
            message('已保存');
            if (saved.enabled) {
                message(`正在连接 ${saved.name}…`);
                try { render(await api.test({ id: saved.id })); message('连接成功，工具已就绪'); }
                catch (error) { render(await api.list()); throw error; }
            }
        });
    });
    void perform(async () => render(await api.list()));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountMcpSettings, { once: true });
else mountMcpSettings();
