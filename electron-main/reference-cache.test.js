const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ReferenceCache } = require('./reference-cache');

test('ReferenceCache: reuses compressed output and keeps a stable reference id', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-canvas-reference-cache-'));
    const sourcePath = path.join(tempDir, 'source.png');
    fs.writeFileSync(sourcePath, 'original-image');
    let calls = 0;
    const compress = async () => {
        calls += 1;
        return {
            buffer: Buffer.from('compressed-image'),
            mimeType: 'image/jpeg',
            width: 640,
            height: 480
        };
    };

    try {
        const cacheDir = path.join(tempDir, 'cache');
        const first = await new ReferenceCache(cacheDir).getOrCreateCompressed({
            sourcePath,
            targetBytes: 1024,
            compress
        });
        const second = await new ReferenceCache(cacheDir).getOrCreateCompressed({
            sourcePath,
            targetBytes: 1024,
            compress
        });
        assert.equal(calls, 1);
        assert.match(first.referenceId, /^ref_[a-f0-9]{24}$/);
        assert.equal(second.referenceId, first.referenceId);
        assert.equal(second.filePath, first.filePath);
        assert.equal(second.cacheReused, true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('ReferenceCache: persists upload URLs but rejects expired entries', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-canvas-upload-cache-'));
    let now = 1_000;
    try {
        const first = new ReferenceCache(tempDir, { now: () => now });
        await first.setUpload('provider:hash', {
            url: 'https://example.test/reference.jpg',
            expiresAt: 2_000,
            referenceId: 'ref_123',
            providerId: 'test'
        });
        const second = new ReferenceCache(tempDir, { now: () => now });
        assert.equal((await second.getUpload('provider:hash')).referenceId, 'ref_123');
        now = 2_001;
        assert.equal(await second.getUpload('provider:hash'), null);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
