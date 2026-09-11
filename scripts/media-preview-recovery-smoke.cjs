// Run after npm run build, with PLAYWRIGHT_MODULE set when Playwright is provided externally.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

function makeBmp(width, height) {
    const stride = Math.ceil(width * 3 / 4) * 4;
    const bytes = Buffer.alloc(54 + stride * height, 128);
    bytes.fill(0, 0, 54);
    bytes.write('BM');
    bytes.writeUInt32LE(bytes.length, 2);
    bytes.writeUInt32LE(54, 10);
    bytes.writeUInt32LE(40, 14);
    bytes.writeInt32LE(width, 18);
    bytes.writeInt32LE(height, 22);
    bytes.writeUInt16LE(1, 26);
    bytes.writeUInt16LE(24, 28);
    bytes.writeUInt32LE(stride * height, 34);
    return bytes;
}

async function verify(resourceSaver) {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-preview-recovery-'));
    let app;
    try {
        await fs.mkdir(path.join(profile, 'data'));
        const mediaRoot = path.join(profile, 'media-root');
        await fs.mkdir(mediaRoot);
        const valid = await sharp({ create: { width: 600, height: 1200, channels: 3, background: '#7599aa' } }).png().toBuffer();
        const fixtures = { bmp: makeBmp(600, 1200), partial: valid.subarray(0, 20), empty: Buffer.alloc(0),
            corrupt: Buffer.from('invalid bitmap'), html: Buffer.from('<!DOCTYPE html><html></html>') };
        const files = {};
        for (const [id, bytes] of Object.entries(fixtures)) {
            files[id] = path.join(profile, `${id}.${id === 'bmp' ? 'bmp' : 'png'}`);
            await fs.writeFile(files[id], bytes);
        }
        files.missing = path.join(profile, 'missing.png');
        const items = Object.entries(files).map(([id, filePath], index) => ({ id, filePath, kind: 'media', mediaType: 'image',
            x: 40 + (index % 3) * 270, y: 90 + Math.floor(index / 3) * 350, width: 130, height: 260 }));
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, activeGroupId: 'recovery', items,
            folderGroups: [{ id: 'recovery', name: 'Preview recovery', savedItems: items, connections: [], folders: [mediaRoot], boardRevision: 0 }],
            connections: [], sidebarClosed: true, resourceSaver, mcp: { enabled: false }, viewport: { x: 0, y: 0, scale: 1 } }));
        const env = { ...process.env, FLOW_MEDIA_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'media-preview-smoke-entry.cjs')], env });
        const page = await app.firstWindow();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.waitForFunction(() => window.flowCanvas?.thumb?.preview && window.Konva?.stages?.length);
        await page.waitForFunction(() => window.Konva.stages[0].findOne('#bmp')?.findOne('.displayNode')?.image?.());
        const inspect = ids => page.evaluate(ids => ids.map(id => {
            const group = window.Konva.stages[0].findOne(`#${id}`);
            const node = group?.findOne('.displayNode');
            const image = node?.image?.();
            return { id, loaded: Boolean(image), pixels: image ? [image.naturalWidth || image.width, image.naturalHeight || image.height] : [],
                size: node ? [node.width(), node.height()] : [], displays: group?.find('.displayNode').length || 0,
                error: group?.findOne('.fallbackErrorBadge')?.findOne('Text')?.text() || '' };
        }), ids);

        const [bmp] = await inspect(['bmp']);
        assert.deepEqual(bmp.pixels, resourceSaver ? [100, 200] : [600, 1200]);
        assert.deepEqual(bmp.size, [130, 260]);
        // Let the initial read fail before completing the two files.
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.ok((await inspect(['partial', 'empty'])).every(item => !item.loaded && !item.error));
        await fs.writeFile(files.partial, valid);
        await fs.writeFile(files.empty, valid);
        await page.waitForFunction(() => ['partial', 'empty'].every(id => window.Konva.stages[0].findOne(`#${id}`)?.findOne('.displayNode')?.image?.()), null, { timeout: 10000 });
        for (const item of await inspect(['partial', 'empty'])) {
            assert.deepEqual(item.pixels, resourceSaver ? [100, 200] : [600, 1200]);
            assert.deepEqual(item.size, [130, 260]);
            assert.equal(item.displays, 1);
            assert.equal(item.error, '');
        }
        await page.waitForFunction(() => window.Konva.stages[0].findOne('#corrupt')?.findOne('.fallbackErrorBadge'), null, { timeout: 12000 });
        for (const item of await inspect(['corrupt', 'html', 'missing'])) {
            assert.equal(item.loaded, false);
            assert.equal(item.error, { corrupt: '图片损坏或不支持', html: '文件是网页', missing: '文件失联' }[item.id]);
        }
        await fs.writeFile(files.partial, Buffer.alloc(0));
        const retryStarted = page.waitForEvent('console', {
            predicate: message => message.type() === 'warning' && message.text().includes(files.partial), timeout: 10000
        });
        await page.locator('#resourceSaverBtn').evaluate(button => button.click());
        await retryStarted;
        await page.locator('#resourceSaverBtn').evaluate(button => button.click());
        await fs.writeFile(files.partial, valid);
        await new Promise(resolve => setTimeout(resolve, 1800));
        const [restored] = await inspect(['partial']);
        assert.equal(restored.displays, 1);
        assert.equal(restored.error, '');
        assert.deepEqual(restored.pixels, resourceSaver ? [100, 200] : [600, 1200]);
        const output = path.join(__dirname, '../output/playwright');
        await fs.mkdir(output, { recursive: true });
        await page.screenshot({ path: path.join(output, `media-recovery-${resourceSaver ? 'thumbnail' : 'full'}.png`) });
        assert.deepEqual(errors, []);
        console.log(`Preview recovery passed (${resourceSaver ? 'thumbnail' : 'full'}): BMP, partial/empty recovery, retry exhaustion, terminal errors, geometry, cancelled stale retries`);
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

(async () => {
    await verify(true);
    await verify(false);
})().catch(error => { console.error(error); process.exitCode = 1; });
