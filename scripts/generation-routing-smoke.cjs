const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-routing-smoke-'));
    let app;
    const pending = [];
    const server = http.createServer(async (req, res) => {
        for await (const chunk of req) void chunk;
        pending.push(res);
    });
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const targetDir = path.join(profile, 'output');
        await fs.mkdir(path.join(profile, 'data'), { recursive: true });
        await fs.mkdir(targetDir);
        const items = [{ id: 'generate', kind: 'op', nodeType: 'image', x: 100, y: 100, width: 264, height: 264,
            config: { providerId: 'image', model: 'gpt-image-2', prompt: 'fixture', count: 2,
                concurrency: 2, size: '1024x1024', resolutionTier: '1K', ratio: '1:1', stream: false } }];
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({
            version: 1, activeGroupId: 'original', items, connections: [], sidebarClosed: false,
            folderGroups: [{ id: 'original', name: 'Original', folders: [targetDir], defaultSaveFolder: targetDir, savedItems: items, connections: [] },
                { id: 'other', name: 'Other', folders: [], savedItems: [], connections: [] }], mcp: { enabled: false }
        }));
        await fs.writeFile(path.join(profile, 'fixture-api.json'), JSON.stringify({ version: 1, revision: 1,
            providers: [{ id: 'image', name: 'Mock', capability: 'image', type: 'openai', apiKey: 'fixture-only',
                endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'gpt-image-2' }],
            globalConfig: { imageProviderId: 'image' } }));
        const env = { ...process.env, FLOW_CANVAS_SMOKE_PROFILE: profile, FLOW_CANVAS_SMOKE_LIVE: '0' };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'agent-smoke-entry.cjs')], env });
        const page = await app.firstWindow();
        page.on('console', message => { if (['warning', 'error'].includes(message.type())) console.error(message.text()); });
        await page.waitForFunction(() => document.querySelector('[data-group-id="other"] .group-header'));
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('context-run-node', { detail: { nodeId: 'generate' } })));
        const deadline = Date.now() + 15000;
        while (pending.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(pending.length, 2, 'Both batch requests must be submitted concurrently');
        await page.locator('[data-group-id="other"] .group-header').click();
        await page.waitForFunction(() => document.querySelector('[data-group-id="other"]').classList.contains('active'));
        const png = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#669977' } }).png().toBuffer();
        pending[0].writeHead(200, { 'content-type': 'application/json' });
        pending[0].end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
        pending[1].writeHead(400, { 'content-type': 'application/json' });
        pending[1].end(JSON.stringify({ error: { message: 'fixture rejected one batch item' } }));
        // Read disk without advancing the renderer preload's revision baseline.
        let data;
        const completedBy = Date.now() + 15000;
        do {
            data = JSON.parse(await fs.readFile(path.join(profile, 'data/board.json'), 'utf8'));
            const node = data.folderGroups.find(group => group.id === 'original').savedItems.find(item => item.id === 'generate');
            if (node.kind === 'media' && node.runStatus === 'error') break;
            await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < completedBy);
        assert.equal(data.activeGroupId, 'other');
        assert.equal(data.items.length, 0);
        assert.equal(data.folderGroups.find(group => group.id === 'other').savedItems.length, 0);
        const original = data.folderGroups.find(group => group.id === 'original');
        assert.equal(original.savedItems[0].runStatus, 'error', JSON.stringify(original.savedItems[0]));
        assert.equal(original.savedItems.length, 1);
        assert.ok(original.savedItems[0].filePath.startsWith(targetDir));
        assert.match(original.savedItems[0].runError, /fixture rejected/);
        await page.locator('[data-group-id="original"] .group-header').click();
        await page.waitForFunction(() => document.querySelector('[data-group-id="original"]').classList.contains('active'));
        const output = path.join(__dirname, '../output/playwright');
        await fs.mkdir(output, { recursive: true });
        await page.screenshot({ path: path.join(output, 'generation-routing.png') });
        console.log('GraphRunner smoke passed: concurrent batch, project switch, partial result persisted only to original project, error state retained.');
    } finally {
        for (const response of pending) if (!response.writableEnded) response.destroy();
        await app?.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
