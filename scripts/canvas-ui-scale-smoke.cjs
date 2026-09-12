const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-ui-scale-'));
    const output = path.resolve(__dirname, '../output/playwright');
    let app;
    try {
        const media = path.join(profile, 'media');
        await fs.mkdir(media);
        const video = path.join(media, 'sample.mp4');
        const encoded = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=10',
            '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { encoding: 'utf8' });
        assert.equal(encoded.status, 0, encoded.stderr);
        const items = [
            { id: 'prompt', kind: 'op', nodeType: 'text', x: 100, y: 100, width: 600, height: 400, config: { text: 'Composition' } },
            { id: 'image', kind: 'op', nodeType: 'image', x: 1000, y: 100, width: 360, height: 360, config: {} },
            { id: 'version', kind: 'op', nodeType: 'image', x: 1000, y: 650, width: 360, height: 360, config: {} },
            { id: 'generated-video', kind: 'op', nodeType: 'video', config: {}, runStatus: 'success',
                resultFilePaths: [video], x: 100, y: 1300, width: 640, height: 360 },
            { id: 'imported-video', kind: 'media', mediaType: 'video', filePath: video,
                x: 1000, y: 1300, width: 640, height: 360 },
            { id: 'empty-video', kind: 'op', nodeType: 'video', config: {},
                x: 100, y: 1900, width: 640, height: 360 }
        ];
        const connections = [
            { id: 'flow-edge', from: { nodeId: 'prompt', port: 'text' }, to: { nodeId: 'image', port: 'source' } },
            { id: 'history-edge', kind: 'history', from: { nodeId: 'image', port: 'image' }, to: { nodeId: 'version', port: 'source' } }
        ];
        await fs.mkdir(path.join(profile, 'data'));
        await fs.mkdir(output, { recursive: true });
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, items, connections,
            activeGroupId: 'fixture', resourceSaver: false,
            folderGroups: [{ id: 'fixture', name: 'UI scale', folders: [media], savedItems: items, connections }],
            mcp: { enabled: false } }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        let page;
        for (let i = 0; i < 100; i++) {
            page = app.windows().find(win => /dist[\\/]index\.html/.test(win.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const ready = () => page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#history-edge')
            && ['generated-video', 'imported-video'].every(id => {
                const node = window.Konva.stages[0].findOne(`#${id}`);
                return node?.findOne('.videoControlGlyph') && node.findOne('.displayNode')?.image()?.readyState >= 2;
            }));
        const zoom = async value => {
            await page.evaluate(value => {
                const stage = window.Konva.stages[0];
                stage.scale({ x: value, y: value });
                stage.position({ x: 80, y: 120 });
            }, value);
            await page.waitForTimeout(100);
        };
        const metrics = () => page.evaluate(() => {
            const stage = window.Konva.stages[0];
            return { portScale: stage.findOne('.graphPort').getAbsoluteScale().x,
                flowWidth: stage.findOne('#flow-edge').strokeWidth(), historyWidth: stage.findOne('#history-edge').strokeWidth(),
                points: stage.findOne('#flow-edge').points(), nodeScale: stage.findOne('#image').scaleX() };
        });
        const openSettings = async () => {
            if (!(await page.locator('#canvasUiScaleLimit').isVisible())) await page.locator('#agentSettingsBtn').click();
            await page.locator('#agentShortcutSettingsTab').click();
        };
        const checkVideoControls = async screenScale => {
            const values = await page.evaluate(() => ['generated-video', 'imported-video'].map(id => {
                const node = window.Konva.stages[0].findOne(`#${id}`);
                const glyph = node.findOne('.videoPlayPauseGlyph');
                const volume = node.findOne('.videoVolumeGlyph');
                const controls = glyph.getParent();
                const progress = controls.findOne('.videoProgressBg');
                return { glyphSize: glyph.getAbsoluteScale().x * 24,
                    volumeSize: volume.getAbsoluteScale().x * 24,
                    progressHeight: progress?.height() * window.Konva.stages[0].scaleX(),
                    centered: !progress || Math.abs(progress.y() + progress.height() / 2 - glyph.y()) < 1e-6,
                    path: glyph.findOne('.videoPlayGlyph').getClassName() };
            }));
            values.forEach(value => {
                assert.ok(Math.abs(value.glyphSize - 18 * screenScale) < 1e-6);
                assert.equal(value.volumeSize, value.glyphSize);
                if (Number.isFinite(value.progressHeight)) assert.equal(value.progressHeight, 4 * screenScale);
                assert.ok(value.centered);
                assert.equal(value.path, 'Path');
            });
        };
        await ready();
        await page.setViewportSize({ width: 1360, height: 900 });
        await openSettings();
        await zoom(0.25);
        const initial = await metrics();
        assert.equal(initial.portScale, 0.5);
        assert.equal(initial.flowWidth, 1.6);
        assert.equal(initial.historyWidth, 1.1);
        await checkVideoControls(0.5);
        await page.screenshot({ path: path.join(output, 'canvas-ui-scale-default.png') });
        const slider = page.locator('#canvasUiScaleLimit');
        await slider.focus();
        await slider.press('Home');
        const small = await metrics();
        assert.equal(small.portScale, 0.25);
        assert.equal(small.flowWidth, 0.8);
        assert.deepEqual(small.points, initial.points);
        assert.equal(small.nodeScale, initial.nodeScale);
        await checkVideoControls(0.25);
        await page.evaluate(() => window.Konva.stages[0].findOne('#flow-edge').fire('mouseenter'));
        assert.equal((await metrics()).flowWidth, 1.1);
        await slider.press('End');
        assert.equal((await metrics()).flowWidth, 4.4, 'Hovered edges follow live slider changes');
        await page.evaluate(() => window.Konva.stages[0].findOne('#flow-edge').fire('mouseleave'));
        assert.equal((await metrics()).flowWidth, 3.2);
        assert.equal((await metrics()).portScale, 1);
        await checkVideoControls(1);
        await page.screenshot({ path: path.join(output, 'canvas-ui-scale-max.png') });
        await page.evaluate(() => window.Konva.stages[0].findOne('.graphPort').fire('mousedown', {}));
        await slider.press('Home');
        const pendingWidth = await page.evaluate(() => {
            const stage = window.Konva.stages[0];
            return stage.findOne('#flow-edge').getLayer().getChildren().find(line => !line.hasName('graphEdge'))?.strokeWidth();
        });
        assert.equal(pendingWidth, 0.8, 'Drag preview follows the same cap');
        await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseup', { clientX: -100, clientY: -100 })));
        await page.reload();
        await ready();
        await zoom(0.25);
        assert.equal((await metrics()).portScale, 0.25, 'Saved cap is applied during graph creation');
        assert.equal((await metrics()).flowWidth, 0.8);
        await checkVideoControls(0.25);
        await openSettings();
        assert.equal(await slider.inputValue(), '1');
        await page.locator('#canvasUiScaleLimitReset').click();
        assert.equal((await metrics()).flowWidth, 1.6);
        await checkVideoControls(0.5);
        await zoom(2);
        assert.equal((await metrics()).flowWidth, 3.2);
        assert.equal((await metrics()).portScale, 1, 'Zooming in does not enlarge the controls');
        await zoom(0.25);
        await page.setViewportSize({ width: 820, height: 680 });
        const setting = page.locator('.canvas-ui-scale-setting');
        assert.equal(await setting.evaluate(el => el.scrollWidth > el.clientWidth), false);
        await page.screenshot({ path: path.join(output, 'canvas-ui-scale-compact.png') });
        await page.locator('#flowCanvasThemeSelect').selectOption('light');
        await page.screenshot({ path: path.join(output, 'canvas-ui-scale-light.png') });
        await page.locator('#flowCanvasThemeSelect').selectOption('dark');
        await page.setViewportSize({ width: 1360, height: 900 });
        await page.locator('#agentSettingsBtn').click();
        await page.locator('#agentToggleBtn').click();
        await page.locator('#agentConversationMenuBtn').click();
        assert.ok(await page.locator('#agentConversationPopover').isVisible());
        await page.locator('#agentConversationMenuBtn').click();
        await page.locator('#agentFilesBtn').click();
        assert.ok(await page.locator('#agentFilesPopover').isVisible());
        await page.locator('#agentFilesBtn').click();
        await page.screenshot({ path: path.join(output, 'iconamoon-agent-header.png') });
        await page.setViewportSize({ width: 820, height: 680 });
        assert.ok(await page.locator('#agentSidebarCloseBtn').isVisible());
        await page.screenshot({ path: path.join(output, 'iconamoon-agent-header-compact.png') });
        await page.locator('#agentSidebarCloseBtn').click();
        await page.waitForFunction(() => !document.body.classList.contains('agent-open'));
        await page.setViewportSize({ width: 1360, height: 900 });
        await zoom(0.5);
        await page.evaluate(() => window.Konva.stages[0].position({ x: 80, y: -450 }));
        const clickControl = async (id, name) => {
            const point = await page.evaluate(({ id, name }) => {
                const stage = window.Konva.stages[0];
                const box = stage.findOne(`#${id}`).findOne(`.${name}`).getClientRect();
                const rect = stage.container().getBoundingClientRect();
                return { x: rect.x + box.x + box.width / 2, y: rect.y + box.y + box.height / 2 };
            }, { id, name });
            await page.mouse.click(point.x, point.y);
        };
        for (const id of ['generated-video', 'imported-video']) {
            await clickControl(id, 'videoVolumeHotspot');
            await page.waitForFunction(id => window.Konva.stages[0].findOne(`#${id}`)
                .findOne('.videoVolumeWave').visible(), id);
            await clickControl(id, 'videoVolumeHotspot');
            await clickControl(id, 'videoPlayPauseHotspot');
            await page.waitForFunction(id => {
                const video = window.Konva.stages[0].findOne(`#${id}`).findOne('.displayNode').image();
                return video.tagName === 'VIDEO' && !video.paused && video.currentTime > 0;
            }, id);
            await clickControl(id, 'videoPlayPauseHotspot');
            await page.waitForFunction(id => window.Konva.stages[0].findOne(`#${id}`)
                .findOne('.videoPlayGlyph').visible(), id);
        }
        await page.screenshot({ path: path.join(output, 'iconamoon-video-controls.png') });
        await page.locator('#resourceSaverBtn').click();
        await page.waitForFunction(() => window.Konva.stages[0].findOne('#imported-video').findOne('.videoCoverControls'));
        await zoom(0.25);
        await checkVideoControls(0.5);
        const pixelCounts = await page.evaluate(() => ['generated-video', 'imported-video'].map(id => {
            const source = window.Konva.stages[0].findOne(`#${id}`).findOne('.displayNode').image();
            const canvas = document.createElement('canvas');
            canvas.width = 32; canvas.height = 18;
            const context = canvas.getContext('2d');
            context.drawImage(source, 0, 0, 32, 18);
            const pixels = context.getImageData(0, 0, 32, 18).data;
            return new Set(Array.from({ length: pixels.length / 4 }, (_, i) =>
                `${pixels[i * 4]},${pixels[i * 4 + 1]},${pixels[i * 4 + 2]}`)).size;
        }));
        assert.ok(pixelCounts.every(count => count > 10), `Missing video cover pixels: ${pixelCounts}`);
        await zoom(0.05);
        assert.ok(await page.evaluate(() => ['generated-video', 'imported-video'].every(id =>
            !window.Konva.stages[0].findOne(`#${id}`).findOne('.videoControlGlyph').isVisible())));
        assert.deepEqual(errors, []);
        console.log('PASS: live UI scale, edges, video controls, cover pixels, play/mute clicks, header actions, reload, and desktop/compact dark/light layouts.');
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
