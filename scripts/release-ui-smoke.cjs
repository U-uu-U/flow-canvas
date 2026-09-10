const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-release-ui-'));
    let app;
    try {
        await fs.mkdir(path.join(profile, 'data'));
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, items: [], folderGroups: [], mcp: { enabled: false } }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        const page = await app.firstWindow();
        await page.waitForFunction(() => window.flowCanvas?.store && document.querySelector('#agentToggleBtn'));
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isVisible()).setSize(1300, 900));
        const settings = page.locator('#agentSettingsBtn');
        assert.equal(await page.locator('.titlebar #agentSettingsBtn').count(), 0);
        assert.equal(await page.locator('#creationModePicker').count(), 0);
        assert.equal(await settings.getAttribute('class'), 'canvas-tool-btn');
        await settings.click();
        await page.waitForFunction(() => document.body.classList.contains('settings-mode') && document.body.classList.contains('agent-open'));
        assert.equal(await settings.getAttribute('aria-expanded'), 'true');
        await settings.click();
        await page.waitForFunction(() => !document.body.classList.contains('agent-open'));
        await page.locator('#agentToggleBtn').click();
        await page.waitForFunction(() => document.body.classList.contains('agent-mode') && document.body.classList.contains('agent-open'));
        await page.waitForFunction(() => document.activeElement === document.querySelector('#agentInput'));
        assert.equal(await page.locator('#agentSendBtn use').getAttribute('href'), './icons/flow-icons.svg#icon-arrow-up');
        const handle = page.locator('#agentSidebarResizeHandle');
        await handle.waitFor({ state: 'visible' });
        // Keyboard controls also exercise persisted clamping without depending on animation timing.
        await handle.focus();
        assert.equal(await handle.evaluate(element => element === document.activeElement), true);
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowLeft');
        assert.equal(await handle.getAttribute('aria-valuenow'), '444');
        await page.waitForTimeout(250);
        const box = await handle.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2, { steps: 8 });
        await page.mouse.up();
        const width = Number(await handle.getAttribute('aria-valuenow'));
        assert.ok(width >= 520 && width <= 528, `Unexpected resized width: ${width}`);
        assert.equal(await page.evaluate(() => document.body.classList.contains('agent-sidebar-resizing')), false);
        await page.locator('#agentSidebarCloseBtn').click();
        await page.waitForFunction(() => !document.body.classList.contains('agent-open'));
        await page.locator('#agentToggleBtn').click();
        assert.equal(Number(await handle.getAttribute('aria-valuenow')), width);
        const output = path.join(__dirname, '../output/playwright');
        await fs.mkdir(output, { recursive: true });
        await page.screenshot({ path: path.join(output, 'release-ui-desktop.png') });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isVisible()).setSize(820, 680));
        await page.waitForTimeout(300);
        assert.ok(Number(await handle.getAttribute('aria-valuenow')) <= Number(await handle.getAttribute('aria-valuemax')));
        const panel = await page.locator('#agentSidebar').boundingBox();
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        assert.ok(panel.x >= -1 && panel.x + panel.width <= viewport.width + 1);
        await page.screenshot({ path: path.join(output, 'release-ui-compact.png') });
        await page.reload();
        await page.waitForFunction(() => window.flowCanvas?.store && document.querySelector('#agentToggleBtn'));
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.isVisible()).setSize(1300, 900));
        await page.locator('#agentToggleBtn').click();
        await page.waitForFunction(() => document.body.classList.contains('agent-open'));
        assert.equal(Number(await handle.getAttribute('aria-valuenow')), width);
        console.log('Release UI smoke passed: settings rail/toggle, no old picker, send icon, drag, keyboard, persistence, compact viewport.');
    } catch (error) {
        const page = app && await app.firstWindow().catch(() => null);
        if (page) {
            const output = path.join(__dirname, '../output/playwright');
            await fs.mkdir(output, { recursive: true });
            await page.screenshot({ path: path.join(output, 'release-ui-failure.png') }).catch(() => {});
            console.error(await page.evaluate(() => ({
                focused: document.activeElement?.id, viewport: innerWidth,
                handle: document.querySelector('#agentSidebarResizeHandle')?.outerHTML,
                mode: document.body.className
            })).catch(() => null));
        }
        throw error;
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
