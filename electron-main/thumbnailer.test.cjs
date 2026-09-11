const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const Thumbnailer = require('./thumbnailer');

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-preview-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return { directory, service: new Thumbnailer() };
}
const bitmap = (width, height) => sharp({ create: { width, height, channels: 4, background: '#609cce88' } });
const pixels = preview => Buffer.from(preview.dataUrl.split(',')[1], 'base64');

test('WebP thumbnail fits both dimensions and preserves original aspect metadata', async t => {
    const { directory, service } = await fixture(t);
    const file = path.join(directory, 'portrait.webp');
    await bitmap(600, 1200).webp().toFile(file);
    const result = await service.getPreview(file, 200);
    assert.equal(result.success, true);
    assert.deepEqual([result.width, result.height], [600, 1200]);
    assert.deepEqual([result.previewWidth, result.previewHeight], [100, 200]);
    assert.equal((await sharp(pixels(result)).metadata()).format, 'png');
    assert.match(await service.getThumbnail(file), /^data:image\/png;base64,/);
});

test('previews decode content rather than relying on a filename extension', async t => {
    const { directory, service } = await fixture(t);
    const file = path.join(directory, 'misnamed.png');
    await bitmap(320, 180).webp().toFile(file);
    assert.equal((await service.getPreview(file)).success, true);
});

test('normal browser images keep their original source; forced fallback produces compatible PNG', async t => {
    const { directory, service } = await fixture(t);
    const file = path.join(directory, 'image.png');
    await bitmap(640, 480).png().toFile(file);
    assert.equal((await service.getPreview(file, 4096, true)).useOriginal, true);
    const forced = await service.getPreview(file, 4096, false);
    assert.equal(forced.useOriginal, false);
    assert.deepEqual([forced.previewWidth, forced.previewHeight], [640, 480]);
});

test('large source uses bounded preview without changing source bytes or geometry', async t => {
    const { directory, service } = await fixture(t);
    const file = path.join(directory, 'large.png');
    await bitmap(5000, 4000).png().toFile(file);
    const hash = async () => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
    const before = await hash();
    const result = await service.getPreview(file, 512, true);
    assert.equal(result.useOriginal, false);
    assert.deepEqual([result.width, result.height], [5000, 4000]);
    assert.ok(result.previewWidth <= 512 && result.previewHeight <= 512);
    assert.equal(await hash(), before);
});

test('TIFF and EXIF-rotated JPEG are decoded into correctly oriented previews', async t => {
    const { directory, service } = await fixture(t);
    const tiff = path.join(directory, 'source.tiff');
    await bitmap(100, 200).tiff().toFile(tiff);
    assert.equal((await service.getPreview(tiff, 200, true)).useOriginal, false);
    const rotated = path.join(directory, 'rotated.jpg');
    await bitmap(400, 200).jpeg().withMetadata({ orientation: 6 }).toFile(rotated);
    const result = await service.getPreview(rotated, 200);
    assert.deepEqual([result.width, result.height], [200, 400]);
    assert.deepEqual([result.previewWidth, result.previewHeight], [100, 200]);
});

test('HTML masquerading as PNG has a distinct error; missing, empty and corrupt inputs differ', async t => {
    const { directory, service } = await fixture(t);
    const file = path.join(directory, 'web.png');
    await fs.writeFile(file, '<!DOCTYPE html><html><head><title>Flow Canvas</title></head><body></body></html>');
    assert.equal((await service.getPreview(file)).error.code, 'NOT_IMAGE_HTML');
    assert.equal((await service.getPreview(path.join(directory, 'missing.png'))).error.code, 'FILE_MISSING');
    const empty = path.join(directory, 'empty.png'); await fs.writeFile(empty, '');
    assert.equal((await service.getPreview(empty)).error.code, 'FILE_EMPTY');
    const corrupt = path.join(directory, 'corrupt.png'); await fs.writeFile(corrupt, 'not an image');
    assert.equal((await service.getPreview(corrupt)).error.code, 'IMAGE_DECODE_FAILED');
});

test('HTML-like metadata inside a valid image is not mistaken for a web page', async t => {
    const { directory, service } = await fixture(t);
    const file = path.join(directory, 'metadata.jpg');
    await bitmap(32, 32).jpeg().withMetadata({ exif: { IFD0: { ImageDescription: '<html>sample text</html>' } } }).toFile(file);
    assert.equal((await service.getPreview(file)).success, true);
});

test('file replacement invalidates failed cache and service restart still loads the image', async t => {
    const { directory, service } = await fixture(t);
    const file = path.join(directory, 'replaced.png');
    await fs.writeFile(file, '<html>bad download</html>');
    assert.equal((await service.getPreview(file)).success, false);
    await bitmap(150, 100).png().toFile(file);
    assert.equal((await service.getPreview(file)).success, true);
    assert.equal((await new Thumbnailer().getPreview(file)).success, true);
});

test('identical requests share decoding and distinct requests are bounded to two concurrent decoders', async t => {
    const { directory, service } = await fixture(t);
    const file = path.join(directory, 'same.png'); await bitmap(32, 32).png().toFile(file);
    let calls = 0, active = 0, peak = 0;
    service._decode = async () => {
        calls++; active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 15)); active--;
        return { success: true, dataUrl: 'data:image/png;base64,a' };
    };
    await Promise.all(Array.from({ length: 10 }, () => service.getPreview(file, 200)));
    assert.equal(calls, 1);
    await Promise.all([100, 101, 102, 103, 104].map(size => service.getPreview(file, size)));
    assert.equal(peak, 2);
});

test('preview cache respects its byte budget', async t => {
    const { directory, service } = await fixture(t);
    const file = path.join(directory, 'budget.png'); await bitmap(64, 64).png().toFile(file);
    service._maxCacheBytes = 800;
    await service.getPreview(file, 32);
    await service.getPreview(file, 48);
    await service.getPreview(file, 64);
    assert.ok(service._cacheBytes <= 800);
});
