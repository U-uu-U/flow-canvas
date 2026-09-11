const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-mcp-ui-'));
    let app;
    let providerCalls = 0;
    const provider = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        providerCalls++;
        const observed = body.messages.some(m => m.role === 'tool');
        const tool = body.tools.find(t => t.function.description.includes('Read test scene'));
        const message = observed ? { role: 'assistant', content: 'Read three scene objects.' }
            : { role: 'assistant', content: '', tool_calls: [{ id: 'scene-call', type: 'function',
                function: { name: tool.function.name, arguments: JSON.stringify({ label: 'Desktop integration' }) } }] };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message, finish_reason: observed ? 'stop' : 'tool_calls' }] }));
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    try {
        await fs.mkdir(path.join(profile, 'data'));
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'mcp-smoke', items: [],
            connections: [], folderGroups: [{ id: 'mcp-smoke', name: 'MCP test', savedItems: [], connections: [], folders: [], boardRevision: 0 }],
            mcp: { enabled: false }, viewport: { x: 0, y: 0, scale: 1 } }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        const page = await app.firstWindow();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.waitForSelector('#agentSettingsBtn');
        await page.locator('#agentSettingsBtn').click();
        await page.locator('#agentApiSettingsTab').click();
        const root = page.locator('#mcpClientSettings');
        await root.locator('[data-action=add]').click();
        await root.locator('[name=name]').fill('Blender / Rhino 测试连接');
        await root.locator('[name=command]').fill(process.execPath);
        await root.locator('[name=args]').fill(JSON.stringify([path.join(__dirname, 'fixtures/mcp-client-server.cjs')]));
        await root.locator('[name=env]').fill(JSON.stringify({ FLOW_MCP_TEST_MARKER: 'ui-marker' }));
        await root.locator('[type=submit]').click();
        await page.waitForFunction(() => document.querySelector('#mcpClientSettings [role=status]').textContent.includes('工具已就绪'));
        assert.match(await root.innerText(), /1 个工具/);
        await root.locator('summary').click();
        assert.match(await root.innerText(), /scene.inspect/);
        const run = await page.evaluate(endpoint => window.flowCanvas.agent.start({ projectId: 'mcp-smoke', conversationId: 'mcp-smoke',
            messages: [{ role: 'user', content: 'Read the external scene.' }],
            provider: { type: 'openai', endpoint, model: 'test-model', apiKey: 'fixture-key' } }),
        `http://127.0.0.1:${provider.address().port}/v1/chat/completions`);
        let result;
        const deadline = Date.now() + 15000;
        do {
            result = await page.evaluate(id => window.flowCanvas.agent.get({ runId: id }), run.id);
            if (['completed', 'failed'].includes(result.status)) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        assert.equal(result.status, 'completed', result.error);
        assert.equal(result.projectId, 'mcp-smoke'); assert.equal(result.conversationId, 'mcp-smoke');
        assert.equal(providerCalls, 2);
        assert.equal(Object.values(result.externalCalls)[0].status, 'completed');
        assert.match(JSON.stringify(Object.values(result.externalCalls)[0].result), /objectCount/);
        await fs.mkdir(path.join(__dirname, '../output/playwright'), { recursive: true });
        await root.screenshot({ path: path.join(__dirname, '../output/playwright/mcp-settings-connected.png') });
        await root.locator('[data-action=edit]').click();
        assert.equal(await root.locator('[name=env]').inputValue(), '');
        await root.locator('[name=name]').fill('Blender / Rhino');
        await root.locator('[type=submit]').click();
        await page.waitForFunction(() => document.querySelector('#mcpClientSettings [role=status]').textContent.includes('工具已就绪'));
        await root.locator('[data-action=toggle]').click();
        await page.waitForFunction(() => document.querySelector('#mcpClientSettings').textContent.includes('已停用'));
        const saved = await page.evaluate(() => window.flowCanvas.mcpClient.list());
        assert.equal(saved.servers[0].enabled, false);
        assert.equal(saved.servers[0].hasEnv, true);
        await root.locator('[data-action=edit]').click();
        await root.locator('[name=transport]').selectOption('http');
        assert.equal(await root.locator('[name=command]').isVisible(), false);
        assert.equal(await root.locator('[name=url]').isVisible(), true);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.isVisible()).setSize(900, 720));
        await root.locator('[name=url]').fill('http://127.0.0.1:1/mcp');
        await root.locator('[name=timeout]').fill('1');
        await root.locator('[name=enabled]').check();
        await root.locator('form').screenshot({ path: path.join(__dirname, '../output/playwright/mcp-settings-form.png') });
        await root.locator('[type=submit]').click();
        await page.waitForFunction(() => document.querySelector('#mcpClientSettings [role=status]').classList.contains('error'));
        assert.match(await root.innerText(), /fetch failed|connect|连接/i);
        await root.locator('[data-action=remove]').click();
        await page.waitForFunction(() => !document.querySelector('#mcpClientSettings [data-id]'));
        assert.deepEqual(errors, []);
        console.log('MCP desktop smoke passed: add/connect/discover/Agent tool loop/edit/secret preservation/disable/HTTP form/error/delete');
    } finally {
        await app?.close();
        provider.closeAllConnections();
        await new Promise(resolve => provider.close(resolve));
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
