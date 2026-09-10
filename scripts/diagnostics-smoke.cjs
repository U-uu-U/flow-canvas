const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-diagnostics-'));
    let app;
    try {
        await fs.mkdir(path.join(profile, 'data'));
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, items: [], folderGroups: [], mcp: { enabled: false } }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        const page = await app.firstWindow();
        await page.waitForFunction(() => window.flowCanvas?.diagnostics);
        await page.evaluate(async () => {
            await window.flowCanvas.apiConfig.save({ version: 1, revision: 100, providers: [
                { id: 'fixture', name: 'Fixture', type: 'openai', capability: 'image', endpoint: 'https://fixture.test/v1',
                    model: 'test-model', apiKey: 'fixture-private-credential' }
            ], globalConfig: {} });
            console.error('diagnostic-renderer-fixture');
            setTimeout(() => { throw new Error('diagnostic-unhandled-fixture'); }, 0);
        });
        await app.evaluate(() => console.error('diagnostic-main-fixture fixture-private-credential Bearer another-secret'));
        await page.evaluate(() => window.flowCanvas.mcp.generateImage({ clientTaskId: 'diagnostic-task', projectId: 'diagnostic-project', nodeId: 'diagnostic-node' }));
        await page.waitForFunction(async () => (await window.flowCanvas.diagnostics.summary()).errors.some(entry => JSON.stringify(entry).includes('diagnostic-unhandled-fixture')));
        await page.locator('#agentSettingsBtn').click();
        await page.locator('#diagnosticsSettings summary').click();
        await page.locator('[data-debug=copy]').click();
        const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
        const report = JSON.parse(copied);
        assert.ok(report.events.some(entry => entry.event === 'ipc.end' && entry.data.clientTaskId === 'diagnostic-task'));
        assert.ok(report.events.some(entry => JSON.stringify(entry).includes('diagnostic-main-fixture')));
        assert.equal(copied.includes('fixture-private-credential'), false,
            JSON.stringify(report.events.filter(entry => JSON.stringify(entry).includes('fixture-private-credential'))));
        assert.equal(copied.includes('another-secret'), false);
        const exportPath = path.join(profile, 'report.json');
        await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportPath);
        await page.locator('[data-debug=export]').click();
        await page.waitForFunction(() => document.querySelector('.diagnostics-status').textContent.includes('已导出'));
        const exported = JSON.parse(await fs.readFile(exportPath, 'utf8'));
        assert.equal(exported.environment.platform, process.platform);
        assert.equal(exported.environment.app, require('../package.json').version);
        assert.equal(exported.sessionId, report.sessionId);
        await fs.mkdir(path.join(__dirname, '../output/playwright'), { recursive: true });
        await page.screenshot({ path: path.join(__dirname, '../output/playwright/diagnostics-desktop.png') });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isVisible()).setSize(900, 720));
        await page.locator('#diagnosticsSettings').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(__dirname, '../output/playwright/diagnostics-compact.png') });
        await app.close(); app = null;
        const files = await fs.readdir(path.join(profile, 'diagnostics'));
        const logs = await fs.readFile(path.join(profile, 'diagnostics', files.find(file => file === 'events.jsonl')), 'utf8');
        assert.match(logs, /diagnostic-main-fixture/);
        assert.equal(logs.includes('fixture-private-credential'), false);
        console.log('Diagnostics smoke passed: renderer/main errors, task correlation, settings, copy, export, redaction, persisted log');
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
