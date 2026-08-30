import test from 'node:test';
import assert from 'node:assert/strict';
import {
    inferClosestAspectRatio,
    inferImageAspectRatio,
    inferImageResolutionTier,
    resolveGenerationDisplaySize,
    resolveImageDimensions
} from './image-node-settings.js';

test('infers image quality tiers from the longest edge', () => {
    assert.equal(inferImageResolutionTier(1024, 1536), '1K');
    assert.equal(inferImageResolutionTier(2048, 2048), '2K');
    assert.equal(inferImageResolutionTier(3840, 2160), '4K');
});

test('infers known aspect ratios and falls back to adaptive', () => {
    assert.equal(inferImageAspectRatio(1920, 1080), '16:9');
    assert.equal(inferImageAspectRatio(1024, 1536), '2:3');
    assert.equal(inferImageAspectRatio(1377, 1000), 'adaptive');
});

test('infers the closest provider-supported video ratio from a reference', () => {
    const ratios = ['adaptive', '16:9', '9:16', '1:1', '2:3', '3:2'];
    assert.equal(inferClosestAspectRatio(1280, 1920, ratios, '16:9'), '2:3');
    assert.equal(inferClosestAspectRatio(1080, 1920, ratios, '16:9'), '9:16');
    assert.equal(inferClosestAspectRatio(1920, 1080, ratios, '16:9'), '16:9');
    assert.equal(inferClosestAspectRatio(0, 0, ratios, '16:9'), '16:9');
});

test('resolves image dimensions from quality and ratio', () => {
    assert.deepEqual(resolveImageDimensions('1K', '1:1'), { width: 1024, height: 1024 });
    assert.deepEqual(resolveImageDimensions('4K', '16:9'), { width: 3840, height: 2160 });
    assert.deepEqual(resolveImageDimensions('4K', '9:16'), { width: 2160, height: 3840 });
});

test('adaptive resolution preserves the reference orientation', () => {
    assert.deepEqual(
        resolveImageDimensions('2K', 'adaptive', { width: 1600, height: 900 }),
        { width: 2048, height: 1152 }
    );
});

test('generated canvas size inherits the first reference display size', () => {
    assert.deepEqual(resolveGenerationDisplaySize({
        kind: 'image',
        referenceSize: { width: 246, height: 328 },
        size: '4096x4096'
    }), { width: 246, height: 328 });
});

test('generated canvas size uses a compact display edge instead of output pixels', () => {
    assert.deepEqual(
        resolveGenerationDisplaySize({ kind: 'image', size: '4096x2048' }),
        { width: 320, height: 160 }
    );
    assert.deepEqual(
        resolveGenerationDisplaySize({ kind: 'video', ratio: '9:16' }),
        { width: 180, height: 320 }
    );
});
