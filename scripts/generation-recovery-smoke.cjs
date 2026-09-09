const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-recovery-ui-'));
    const png = await sharp({ create: { width: 128, height: 96, channels: 3, background: '#62aa8a' } }).png().toBuffer();
    const requests = [];
    let downloads = 0;
    let app;
    const server = http.createServer((req, res) => {
        requests.push({ method: req.method, url: req.url });
        if (req.url === '/image.png') {
            if (++downloads === 1) { res.statusCode = 502; res.end('temporary CDN failure'); return; }
            res.setHeader('content-type', 'image/png'); res.end(png); return;
        }
        res.setHeader('content-type', 'application/json');
        if (req.url.includes('remote-image')) {
            res.end(JSON.stringify({ status: 'completed', data: [{ url: `http://127.0.0.1:${server.address().port}/image.png` }] }));
        } else { res.statusCode = 401; res.end(JSON.stringify({ error: 'fixture key rejected' })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const targetDir = path.join(profile, 'outputs');
        await fs.mkdir(path.join(profile, 'data'));
        await fs.mkdir(targetDir);
        const node = { id: 'image-node', kind: 'op', nodeType: 'image', config: { prompt: 'recover me' }, x: 10, y: 10, width: 400, height: 300, runStatus: 'canceled' };
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'other', items: [], connections: [],
            folderGroups: [{ id: 'original', name: 'Original', savedItems: [node], connections: [], folders: [], boardRevision: 0 },
                { id: 'other', name: 'Other', savedItems: [], connections: [], folders: [], boardRevision: 0 }],
            mcp: { enabled: false }, viewport: { x: 0, y: 0, scale: 1 } }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        const page = await app.firstWindow();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.waitForSelector('#agentTaskHistoryBtn', { state: 'attached' });
        await page.evaluate(async ({ endpoint, targetDir }) => {
            const providers = [{ id: 'fixture', name: 'Recovery test API', type: 'openai', capability: 'image', model: 'gpt-image-2', models: ['gpt-image-2'], endpoint, apiKey: 'fixture' }];
            await window.flowCanvas.apiConfig.save({ version: 1, revision: 100, providers, globalConfig: {} });
            localStorage.setItem('flow-canvas-agent-providers', JSON.stringify(providers));
            localStorage.setItem('flow-canvas-api-config-meta-v1', JSON.stringify({ version: 1, revision: 100 }));
            localStorage.setItem('flow-canvas-generation-tasks', JSON.stringify([
                { id: 'local-image', kind: 'image', projectId: 'original', status: 'canceled', providerId: 'fixture', providerName: 'Recovery test API',
                    model: 'gpt-image-2', prompt: 'recover me', taskId: null, params: { nodeId: 'image-node', targetDir }, sourcePaths: [], createdAt: new Date().toISOString() },
                { id: 'local-bad', kind: 'image', projectId: 'original', status: 'failed', providerId: 'fixture', providerName: 'Recovery test API',
                    model: 'gpt-image-2', prompt: 'show error', taskId: 'bad-task', params: { targetDir }, sourcePaths: [], createdAt: new Date().toISOString() }
            ]));
        }, { endpoint: `http://127.0.0.1:${server.address().port}/v1`, targetDir });
        await page.reload();
        await page.locator('#agentTaskHistoryBtn').click();
        const recover = page.locator('[data-recover-task="local-image"]:not([data-edit-task-id])');
        await recover.click();
        await page.locator('.generation-recovery-dialog input').fill('remote-image');
        await fs.mkdir(path.join(__dirname, '../output/playwright'), { recursive: true });
        await page.screenshot({ path: path.join(__dirname, '../output/playwright/recovery-id-dialog.png') });
        await page.locator('.generation-recovery-dialog button[value=recover]').click();
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('flow-canvas-generation-tasks')).find(t => t.id === 'local-image').status === 'success');
        let state = await page.evaluate(() => window.flowCanvas.store.load());
        assert.equal(state.activeGroupId, 'other');
        assert.equal(state.items.length, 0);
        let restored = state.folderGroups.find(g => g.id === 'original').savedItems[0];
        assert.equal(restored.width, 400); assert.equal(restored.height, 300);
        assert.equal(restored.runStatus, 'done');
        await fs.access(restored.filePath);
        const count = requests.length;
        await recover.click();
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('flow-canvas-generation-tasks')).find(t => t.id === 'local-image').status === 'success');
        assert.equal(requests.length, count, 'cached recovery must not request server again');
        await page.locator('[data-copy-remote-task="local-image"]').click();
        assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'remote-image');
        await page.locator('[data-recover-task="local-bad"]:not([data-edit-task-id])').click();
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('flow-canvas-generation-tasks')).find(t => t.id === 'local-bad').status === 'disconnected');
        assert.match(await page.locator('#agentTaskHistoryList').innerText(), /401/);
        await page.screenshot({ path: path.join(__dirname, '../output/playwright/recovery-history.png') });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.isVisible()).setSize(900, 720));
        await page.locator('[data-recover-task="local-image"][data-edit-task-id]').click();
        await page.screenshot({ path: path.join(__dirname, '../output/playwright/recovery-compact.png') });
        await page.locator('.generation-recovery-dialog button[value=cancel]').click();
        await page.evaluate(() => localStorage.removeItem('flow-canvas-generation-tasks'));
        await page.reload();
        await page.locator('#agentTaskHistoryBtn').click();
        await page.waitForSelector('[data-recover-task="local-image"]');
        state = await page.evaluate(() => window.flowCanvas.store.load());
        restored = state.folderGroups.find(g => g.id === 'original').savedItems[0];
        assert.equal(restored.resultEntries.length, 1);
        assert.ok(requests.every(request => request.method === 'GET'), 'recovery must never POST a generation');
        assert.deepEqual(errors, []);
        console.log('Recovery desktop smoke passed: canceled task/manual ID/GET query/download/original project/cache/copy/error/renderer reload');
    } finally {
        await app?.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
