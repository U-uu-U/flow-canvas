const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Thumbnailer = require('./thumbnailer');

function createNativeImageStub() {
    const state = { decodes: 0 };
    return {
        state,
        api: {
            createFromBuffer(buffer) {
                state.decodes++;
                const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
                return {
                    isEmpty: () => false,
                    getSize: () => ({ width: 400, height: 100 }),
                    resize: () => ({ toDataURL: () => dataUrl }),
                    toDataURL: () => dataUrl
                };
            }
        }
    };
}

function createFixture(t, name, contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcanvas-thumbnailer-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, contents);
    return filePath;
}

test('loads asynchronously and returns cached thumbnails', async t => {
    const filePath = createFixture(t, 'sample.png', 'sample-image');
    const stub = createNativeImageStub();
    const thumbnailer = new Thumbnailer(1, { nativeImage: stub.api, fs });

    const first = await thumbnailer.getThumbnail(filePath);
    const second = await thumbnailer.getThumbnail(filePath);

    assert.match(first, /^data:image\/png;base64,/);
    assert.equal(second, first);
    assert.equal(stub.state.decodes, 1);
    assert.deepEqual(
        { hits: thumbnailer.getCacheStats().hits, misses: thumbnailer.getCacheStats().misses },
        { hits: 1, misses: 1 }
    );
});

test('coalesces concurrent requests for the same file', async t => {
    const filePath = createFixture(t, 'concurrent.png', 'concurrent-image');
    const stub = createNativeImageStub();
    const thumbnailer = new Thumbnailer(1, { nativeImage: stub.api, fs });

    const [first, second, third] = await Promise.all([
        thumbnailer.getThumbnail(filePath),
        thumbnailer.getThumbnail(filePath),
        thumbnailer.getThumbnail(filePath)
    ]);

    assert.equal(first, second);
    assert.equal(second, third);
    assert.equal(stub.state.decodes, 1);
    assert.equal(thumbnailer.getCacheStats().coalesced, 2);
});

test('replaces stale entries without double-counting memory', async t => {
    const filePath = createFixture(t, 'changed.png', 'old');
    const stub = createNativeImageStub();
    const thumbnailer = new Thumbnailer(1, { nativeImage: stub.api, fs });

    await thumbnailer.getThumbnail(filePath);
    fs.writeFileSync(filePath, 'new-and-longer-image-contents');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(filePath, future, future);
    const updated = await thumbnailer.getThumbnail(filePath);
    const stats = thumbnailer.getCacheStats();

    assert.equal(stats.cacheSize, 1);
    assert.equal(stats.memoryUsedBytes, Buffer.byteLength(updated, 'utf8'));
    assert.equal(stats.misses, 2);
});

test('does not cache an entry larger than the memory budget', async t => {
    const filePath = createFixture(t, 'oversized.png', 'oversized-image');
    const stub = createNativeImageStub();
    const thumbnailer = new Thumbnailer(0.000001, { nativeImage: stub.api, fs });

    await thumbnailer.getThumbnail(filePath);
    await thumbnailer.getThumbnail(filePath);

    assert.equal(stub.state.decodes, 2);
    assert.equal(thumbnailer.getCacheStats().cacheSize, 0);
    assert.equal(thumbnailer.getCacheStats().memoryUsedBytes, 0);
});
