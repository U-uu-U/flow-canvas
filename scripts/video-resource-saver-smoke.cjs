const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-video-saver-'));
    let app;
    try {
        const media = path.join(profile, 'media');
        await fs.mkdir(media);
        await fs.mkdir(path.join(profile, 'data'));
        const video = path.join(media, 'sample.mp4');
        const encoded = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10',
            '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { encoding: 'utf8' });
        assert.equal(encoded.status, 0, encoded.stderr);
        const items = [
            { id: 'generated-video', kind: 'op', nodeType: 'video', config: {}, runStatus: 'success',
                resultFilePaths: [video], x: 120, y: 100, width: 320, height: 180 },
            { id: 'imported-video', kind: 'media', mediaType: 'video', filePath: video,
                x: 520, y: 100, width: 320, height: 180 }
        ];
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({
            version: 1, items, activeGroupId: 'test', connections: [], resourceSaver: false,
            folderGroups: [{ id: 'test', name: 'Video cover test', savedItems: items,
                folders: [media], connections: [], boardRevision: 0 }],
            mcp: { enabled: false }, viewport: { x: 0, y: 0, scale: 1 }
        }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'),
            args: [path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        const page = await app.firstWindow();
        const waitForFrames = async () => page.waitForFunction(() => ['generated-video', 'imported-video'].every(id => {
            const source = window.Konva?.stages?.[0]?.findOne(`#${id}`)?.findOne('.displayNode')?.image();
            return source && (source.tagName === 'VIDEO' ? source.readyState >= 2 : source.width > 0);
        }));
        await waitForFrames();
        const checkPixels = async () => {
            const colors = await page.evaluate(() => ['generated-video', 'imported-video'].map(id => {
                const source = window.Konva.stages[0].findOne(`#${id}`).findOne('.displayNode').image();
                const canvas = document.createElement('canvas');
                canvas.width = 32; canvas.height = 18;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(source, 0, 0, 32, 18);
                const pixels = ctx.getImageData(0, 0, 32, 18).data;
                return new Set(Array.from({ length: pixels.length / 4 }, (_, i) =>
                    `${pixels[i * 4]},${pixels[i * 4 + 1]},${pixels[i * 4 + 2]}`)).size;
            }));
            assert.ok(colors.every(count => count > 10), `Missing video pixels: ${colors}`);
        };
        for (let i = 0; i < 3; i++) {
            await page.locator('#resourceSaverBtn').click();
            await page.waitForFunction(() => document.querySelector('#resourceSaverBtn').getAttribute('aria-checked') === 'true');
            await page.waitForFunction(() => window.Konva.stages[0].findOne('#imported-video').findOne('.videoCover'));
            await waitForFrames();
            await checkPixels();
            await page.locator('#resourceSaverBtn').click();
            await page.waitForFunction(() => window.Konva.stages[0].findOne('#imported-video').findOne('.videoControls'));
            await waitForFrames();
        }
        const output = path.join(__dirname, '../output/playwright');
        await fs.mkdir(output, { recursive: true });
        for (const [scale, visible] of [[0.1, false], [0.25, true], [1, true]]) {
            await page.evaluate(scale => window.Konva.stages[0].scale({ x: scale, y: scale }), scale);
            await page.waitForFunction(visible => ['generated-video', 'imported-video'].every(id =>
                window.Konva.stages[0].findOne(`#${id}`).findOne('.videoControls').isVisible() === visible), visible);
            await checkPixels();
            await page.screenshot({ path: path.join(output, `video-saver-${scale}.png`) });
        }
        console.log('Video cover pixels survive saver toggles; controls hide at small sizes and return on zoom.');
    } finally {
        await app?.close().catch(() => {});
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
