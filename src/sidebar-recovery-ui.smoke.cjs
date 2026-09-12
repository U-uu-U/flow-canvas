/* global window, document, getComputedStyle, innerWidth, URL, process, console */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.argv[2] || process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const { createServer } = await import('vite');
    const server = await createServer({ server: { port: 0, strictPort: false, open: false } });
    let browser;
    try {
        await server.listen();
        const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
        browser = await chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
        const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
        const errors = [];
        const externalRequests = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', async route => {
            const url = route.request().url();
            if (!url.startsWith(origin)) { externalRequests.push(url); return route.abort(); }
            if (new URL(url).pathname !== '/__sidebar-recovery-test') return route.continue();
            await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head>
                <link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/generation-recovery.css">
                <link rel="stylesheet" href="/sidebar-interactions.css">
                <style>body{overflow:auto;padding:16px}#fixture{max-width:680px;margin:auto}
                #library-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
                #runtime,#history{margin-top:16px}</style></head><body><main id="fixture">
                <section id="library"><div id="library-grid"></div></section>
                <button id="after-library" type="button">Next</button><div id="runtime"></div><div id="history"></div><div id="titlebarStatus"></div>
                </main></body></html>` });
        });
        await page.goto(`${origin}/__sidebar-recovery-test`);
        await page.evaluate(async () => {
            const [{ SidebarManager }, { AgentSidebar }, { createRuntimeCard }, { requestRecoveryTaskId }] = await Promise.all([
                import('/sidebar.js'), import('/agent-sidebar.js'), import('/agent-runtime-view.js'), import('/generation-recovery-dialog.js')
            ]);
            window.fixture = { reveals: [], opens: [], actions: [], recoveries: [], retries: [] };
            window.flowCanvas = { shell: { openFile: async path => window.fixture.opens.push(path) } };
            const sidebar = Object.assign(Object.create(SidebarManager.prototype), {
                storeData: { items: [], assetLibrary: { folders: ['C:/fixtures'] } }, listeners: {},
                assetLibraryFiles: ['C:/fixtures/a.png', 'C:/fixtures/b.png'], assetLibraryMetadata: new Map(),
                assetLibrarySource: '', assetLibraryQuery: '', assetLibraryCategory: '', assetLibraryLoading: false,
                dom: { assetLibraryGrid: document.querySelector('#library-grid'), assetLibraryPanel: document.querySelector('#library') }
            });
            sidebar.on('revealAsset', value => window.fixture.reveals.push(value));
            sidebar._updateAssetClassification = async (path, patch) => {
                sidebar.assetLibraryMetadata.set(sidebar._normalizePath(path), { ...sidebar._assetMetadata(path), ...patch });
                sidebar._renderAssetLibraryGrid();
            };
            sidebar._renderAssetLibraryGrid();
            sidebar.bindEvents();
            const card = createRuntimeCard({ onAction: async (...args) => window.fixture.actions.push(args) });
            const run = { id: 'run', status: 'interrupted', events: [], steps: [] };
            card.update(run);
            document.querySelector('#runtime').append(card.root);
            window.fixture.card = card;
            window.fixture.run = run;
            window.fixture.openRecovery = () => {
                window.fixture.recoveryResult = 'pending';
                void requestRecoveryTaskId({ providerName: 'Fixture', model: 'fixture-model' })
                    .then(result => { window.fixture.recoveryResult = result; });
            };
            const agent = Object.assign(Object.create(AgentSidebar.prototype), {
                options: { getActiveProjectId: () => 'project' }, taskHistoryFilter: 'all',
                taskHistoryList: document.querySelector('#history'), globalConfig: {},
                generationTasks: [
                    { id: 'complete', kind: 'image', status: 'success', projectId: 'project', taskId: 'remote',
                        prompt: 'Completed fixture', filePath: 'C:/fixtures/a.png', filePaths: ['C:/fixtures/a.png', 'C:/fixtures/b.png'] },
                    { id: 'failed', kind: 'image', status: 'failed', projectId: 'project', prompt: 'Failed fixture' },
                    { id: 'known', kind: 'image', status: 'disconnected', projectId: 'project', taskId: 'known-remote', prompt: 'Known fixture' }
                ], _captureShortcut() {}, _closeAgentComposerPopovers() {}, _closeAgentHeaderPopovers() {},
                _recoverGenerationTask: (...args) => window.fixture.recoveries.push(args),
                _retryGenerationTask: (...args) => window.fixture.retries.push(args)
            });
            document.addEventListener('generation-task-locate', event => window.fixture.reveals.push(event.detail));
            document.addEventListener('library-asset-drop', () => { throw new Error('locating must never add an asset'); });
            agent._renderGenerationTasks();
            agent._bindEvents();
            window.fixture.agent = agent;
        });
        const firstCard = page.locator('.asset-library-card').first();
        await page.keyboard.press('Tab');
        assert.equal(await firstCard.evaluate(node => node === document.activeElement), true);
        await page.keyboard.press('Enter');
        assert.deepEqual(await page.evaluate(() => window.fixture.reveals), [{ filePath: 'C:/fixtures/a.png' }]);
        await page.keyboard.press('Tab');
        assert.equal(await firstCard.locator('[data-classify-asset]').evaluate(node => node === document.activeElement), true);
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('[data-favorite]').evaluate(node => node === document.activeElement), true);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.asset-classification-menu').count(), 0);
        assert.equal(await firstCard.locator('[data-classify-asset]').evaluate(node => node === document.activeElement), true);
        await page.keyboard.press('Enter');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.querySelector('.asset-classification-menu'));
        assert.equal(await firstCard.locator('[data-classify-asset]').evaluate(node => node === document.activeElement), true);
        assert.match(await firstCard.innerText(), /角色/);
        assert.equal(await page.evaluate(() => window.fixture.reveals.length), 1, 'classification must not reveal the asset');
        await firstCard.focus();
        await page.keyboard.press('Shift+F10');
        assert.equal(await page.locator('.asset-classification-menu').count(), 1);
        await page.keyboard.press('Escape');
        assert.equal(await firstCard.evaluate(node => node === document.activeElement), true);

        await page.evaluate(() => window.fixture.openRecovery());
        const input = page.locator('.generation-recovery-dialog input');
        await input.fill('  remote-enter  ');
        await input.press('Enter');
        await page.waitForFunction(() => window.fixture.recoveryResult === 'remote-enter');
        await page.evaluate(() => window.fixture.openRecovery());
        await input.fill('   ');
        await input.press('Enter');
        assert.equal(await page.locator('dialog[open]').count(), 1);
        assert.equal(await page.locator('button[value="cancel"]').getAttribute('type'), 'button');
        await page.locator('button[value="cancel"]').click();
        await page.waitForFunction(() => window.fixture.recoveryResult === null);
        await page.evaluate(() => window.fixture.openRecovery());
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => window.fixture.recoveryResult === null);

        await page.getByRole('button', { name: '继续已确认计划', exact: true }).click();
        assert.deepEqual(await page.evaluate(() => window.fixture.actions), [['run', 'resume', undefined]]);
        const complete = page.locator('.agent-task-item').filter({ has: page.locator('[data-copy-task-prompt="complete"]') });
        await complete.locator('[data-output-action="locate"][data-output-index="1"]').click();
        await complete.locator('[data-output-action="open"][data-output-index="0"]').click();
        assert.deepEqual(await page.evaluate(() => window.fixture.opens), ['C:/fixtures/a.png']);
        assert.deepEqual(await page.evaluate(() => window.fixture.reveals.at(-1)), {
            projectId: 'project', nodeId: null, filePath: 'C:/fixtures/b.png'
        });
        for (const mode of ['reject', 'string', 'object']) {
            await page.evaluate(mode => {
                window.flowCanvas.shell.openFile = async () => {
                    if (mode === 'reject') throw new Error('fixture open failed');
                    return mode === 'string' ? 'fixture open failed' : { success: false, error: 'fixture open failed' };
                };
            }, mode);
            await complete.locator('[data-output-action="open"]').first().click();
            assert.match(await page.locator('#titlebarStatus').innerText(), /打开文件失败：fixture open failed/);
            await page.getByRole('button', { name: '关闭报错', exact: true }).click();
        }
        assert.equal(await complete.getByRole('button', { name: '拉取产物', exact: true }).isVisible(), false);
        await complete.locator('[data-task-recovery-id] summary').click();
        await page.evaluate(() => window.fixture.agent._renderGenerationTasks());
        assert.equal(await complete.locator('[data-task-recovery-id]').getAttribute('open'), '');
        await complete.getByRole('button', { name: '拉取产物', exact: true }).click();
        assert.deepEqual(await page.evaluate(() => window.fixture.recoveries), [['complete', false]]);
        assert.equal(await page.locator('[data-retry-task="complete"]').count(), 0);
        assert.equal(await page.locator('[data-retry-task="known"]').count(), 0);
        await page.locator('[data-retry-task="failed"]').click();
        assert.deepEqual(await page.evaluate(() => window.fixture.retries), [['failed']]);
        await page.evaluate(() => window.fixture.agent.options.getActiveProjectId = () => 'other');
        await page.evaluate(() => window.fixture.agent._renderGenerationTasks());
        assert.equal(await complete.locator('[data-output-action="locate"]').first().isDisabled(), true);

        await page.evaluate(() => { document.querySelector('#library').hidden = false; });
        const screenshotDir = process.argv.includes('--screenshots')
            ? await fs.mkdtemp(path.join(os.tmpdir(), 'flow-sidebar-ui-')) : null;
        for (const width of [1100, 390]) {
            await page.setViewportSize({ width, height: 850 });
            await page.keyboard.press('Tab');
            await firstCard.focus();
            assert.equal(await firstCard.evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            const screenshotPath = screenshotDir ? path.join(screenshotDir, `sidebar-${width}.png`) : null;
            const screenshot = await page.screenshot({ fullPage: true, ...(screenshotPath ? { path: screenshotPath } : {}) });
            assert.ok(screenshot.length > 10000);
            if (screenshotPath) console.log(screenshotPath);
        }
        assert.deepEqual(externalRequests, []);
        assert.deepEqual(errors, []);
        console.log('Sidebar/recovery browser smoke passed: keyboard classification, focus return, recovery Enter/cancel/Escape, resume label, output actions, advanced recovery, unchanged retry controls, desktop/mobile layout. No external requests.');
    } finally {
        await browser?.close();
        await server.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
