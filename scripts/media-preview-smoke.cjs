const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-media-smoke-'));
    let app;
    try {
        await fs.mkdir(path.join(profile, 'data'));
        const mediaRoot = path.join(profile, 'media-root');
        await fs.mkdir(mediaRoot);
        const generated = path.join(profile, 'large.webp');
        await sharp({ create: { width: 5000, height: 4000, channels: 3, background: '#73b19f' } }).webp().toFile(generated);
        const samples = process.env.FLOW_MEDIA_SAMPLES ? JSON.parse(process.env.FLOW_MEDIA_SAMPLES) : [generated];
        const invalid = process.env.FLOW_MEDIA_HTML_SAMPLE || path.join(profile, 'web.png');
        if (!process.env.FLOW_MEDIA_HTML_SAMPLE) await fs.writeFile(invalid, '<!DOCTYPE html><html><head><title>Flow Canvas</title></head></html>');
        const checksum = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
        const before = await Promise.all([...samples, invalid].map(checksum));
        const items = [];
        for (const [index, filePath] of samples.entries()) {
            const metadata = await sharp(await fs.readFile(filePath)).metadata();
            items.push({ id: `preview-${index}`, kind: 'media', mediaType: 'image', filePath, title: path.basename(filePath),
                x: 100 + index * 310, y: 90, width: 260, height: 260 * metadata.height / metadata.width });
        }
        items.push({ id: 'invalid-html', kind: 'media', mediaType: 'image', filePath: invalid, x: 120, y: 490, width: 260, height: 130 });
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'media-smoke', items,
            folderGroups: [{ id: 'media-smoke', name: 'Media preview verification', savedItems: items, connections: [], folders: [mediaRoot], boardRevision: 0 }],
            connections: [], sidebarClosed: true, resourceSaver: true, mcp: { enabled: false }, viewport: { x: 0, y: 0, scale: 1 } }));
        const launch = async () => {
            const env = { ...process.env, FLOW_MEDIA_SMOKE_PROFILE: profile };
            delete env.ELECTRON_RUN_AS_NODE;
            app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'media-preview-smoke-entry.cjs')], env });
            const page = await app.firstWindow();
            await page.waitForFunction(() => window.flowCanvas?.thumb?.preview && window.Konva?.stages?.length);
            await page.waitForFunction(count => {
                const stage = window.Konva.stages[0];
                return Array.from({ length: count }, (_, i) => stage.findOne(`#preview-${i}`)?.findOne('.displayNode')?.image?.())
                    .every(image => image?.naturalWidth > 0) && stage.findOne('#invalid-html')?.findOne('.fallbackErrorBadge')?.findOne('Text')?.text() === '文件是网页';
            }, samples.length, { timeout: 30000 });
            return page;
        };
        const page = await launch();
        const native = await app.evaluate(({ nativeImage }, files) => files.map(file => ({
            file, nativeEmpty: nativeImage.createFromPath(file).isEmpty()
        })), samples);
        console.log('Native decoder comparison:', JSON.stringify(native));
        const dimensions = async () => page.evaluate(count => Array.from({ length: count }, (_, i) => {
            const node = window.Konva.stages[0].findOne(`#preview-${i}`).findOne('.displayNode');
            return { width: node.width(), height: node.height(), pixels: [node.image().naturalWidth, node.image().naturalHeight] };
        }), samples.length);
        assert.ok((await dimensions()).every(item => Math.max(...item.pixels) <= 200));
        await page.locator('#resourceSaverBtn').evaluate(button => button.click());
        await page.waitForFunction(() => document.querySelector('#resourceSaverBtn').getAttribute('aria-checked') === 'false');
        await page.waitForFunction(count => Array.from({ length: count }, (_, i) =>
            window.Konva.stages[0].findOne(`#preview-${i}`)?.findOne('.displayNode')?.image()?.naturalWidth > 200).every(Boolean), samples.length);
        for (const [index, size] of (await dimensions()).entries()) {
            assert.equal(size.width, items[index].width);
            assert.ok(Math.abs(size.height - items[index].height) < 0.01);
        }
        const output = path.join(__dirname, '../output/playwright');
        await fs.mkdir(output, { recursive: true });
        await page.screenshot({ path: path.join(output, 'media-preview-recovered.png') });
        await app.close(); app = null;
        const restarted = await launch();
        await restarted.screenshot({ path: path.join(output, 'media-preview-after-restart.png') });
        assert.deepEqual(await Promise.all([...samples, invalid].map(checksum)), before);
        console.log(`Media preview smoke passed: ${samples.length} images, thumbnail/full preview, restart, exact geometry, HTML diagnosis, unchanged source files`);
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
