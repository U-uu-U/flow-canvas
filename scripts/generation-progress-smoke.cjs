const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-progress-ui-'));
    let app;
    try {
        await fs.mkdir(path.join(profile, 'data'));
        const node = { id: 'running-video', kind: 'op', nodeType: 'video', config: { prompt: 'Timer fixture' },
            x: 400, y: 200, width: 480, height: 270, runStatus: 'running', runStartedAt: Date.now() - 61000 };
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'original', items: [node], connections: [],
            folderGroups: [{ id: 'original', name: 'Timer', savedItems: [node], connections: [], folders: [], boardRevision: 0 },
                { id: 'other', name: 'Other', savedItems: [], connections: [], folders: [], boardRevision: 0 }],
            mcp: { enabled: false }, viewport: { x: 0, y: 0, scale: 1 } }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        const page = await app.firstWindow();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#running-video')?.findOne('.generationElapsed'));
        const initial = await page.evaluate(() => {
            const group = window.Konva.stages[0].findOne('#running-video');
            window.timerSmokeAnimation = group.getAttr('generatorAnimation');
            return group.findOne('.generationElapsed').text();
        });
        assert.match(initial, /^01:\d\d$/);
        await page.locator('#canvasEmpty').waitFor({ state: 'hidden' });
        await page.waitForFunction(previous => window.Konva.stages[0].findOne('#running-video').findOne('.generationElapsed').text() !== previous, initial);
        await fs.mkdir(path.join(__dirname, '../output/playwright'), { recursive: true });
        await page.screenshot({ path: path.join(__dirname, '../output/playwright/generation-timer-desktop.png') });
        await page.mouse.move(750, 380);
        await page.mouse.wheel(0, -160);
        const zoomed = await page.evaluate(() => window.Konva.stages[0].findOne('#running-video').findOne('.generationElapsed').text());
        assert.ok(zoomed >= initial, 'zoom must not reset timer');
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.isVisible()).setSize(900, 720));
        await page.evaluate(() => {
            const stage = window.Konva.stages[0];
            const group = stage.findOne('#running-video');
            const label = group.findOne('.generationElapsed');
            const scale = stage.scaleX();
            stage.position({ x: (stage.width() - label.width() * scale) / 2 - group.x() * scale,
                y: (stage.height() - label.height() * scale) / 2 - group.y() * scale });
            stage.draw();
        });
        await page.screenshot({ path: path.join(__dirname, '../output/playwright/generation-timer-compact.png') });
        await page.locator('.folder-group-item[data-group-id="other"] .group-header').click();
        await page.waitForFunction(() => !window.Konva.stages[0].findOne('#running-video'));
        assert.equal(await page.evaluate(() => window.timerSmokeAnimation.isRunning()), false, 'project switch must stop detached animation');
        await page.locator('.folder-group-item[data-group-id="original"] .group-header').click();
        await page.waitForFunction(() => window.Konva.stages[0].findOne('#running-video')?.findOne('.generationElapsed'));
        const resumed = await page.evaluate(() => window.Konva.stages[0].findOne('#running-video').findOne('.generationElapsed').text());
        assert.ok(resumed >= zoomed, 'returning to project must preserve start time');
        await page.evaluate(() => localStorage.setItem('flow-canvas-generation-tasks', JSON.stringify([
            { id: 'completed-video', kind: 'video', projectId: 'original', status: 'success', taskId: 'remote-video',
                params: { nodeId: 'running-video' }, createdAt: new Date().toISOString() }
        ])));
        await page.reload();
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#running-video')?.findOne('.generationRecoveryControl'));
        assert.equal(await page.evaluate(() => Boolean(window.Konva.stages[0].findOne('#running-video').findOne('.generationElapsed'))), false,
            'completed task without a landed output must offer recovery instead of animating forever');
        assert.deepEqual(errors, []);
        console.log('Generation progress desktop smoke passed: centered timer/increment/zoom/project switch/animation cleanup/resume/completed task recovery');
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
