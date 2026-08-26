import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getGeneratorComposerPosition,
    getGeneratorPlaceholderSize,
    parseAspectRatio
} from './generator-placeholder-layout.js';

test('parseAspectRatio accepts named ratios and rejects invalid values', () => {
    assert.equal(parseAspectRatio('16:9'), 16 / 9);
    assert.equal(parseAspectRatio('adaptive'), null);
    assert.equal(parseAspectRatio('0:4'), null);
});

test('generator placeholder follows configured or reference aspect ratio', () => {
    assert.deepEqual(getGeneratorPlaceholderSize('image', { ratio: '1:1' }), { width: 264, height: 264 });
    assert.deepEqual(getGeneratorPlaceholderSize('video', { ratio: '16:9' }), { width: 320, height: 180 });
    assert.deepEqual(
        getGeneratorPlaceholderSize('image', { ratio: 'adaptive' }, { width: 900, height: 1600 }),
        { width: 149, height: 264 }
    );
});

test('composer prefers below and clamps inside the viewport', () => {
    assert.deepEqual(
        getGeneratorComposerPosition(
            { left: 360, top: 100, right: 620, bottom: 360, width: 260, height: 260 },
            { width: 560, height: 220 },
            { width: 1000, height: 760 }
        ),
        { left: 210, top: 374, placement: 'below' }
    );
    assert.deepEqual(
        getGeneratorComposerPosition(
            { left: 8, top: 610, right: 270, bottom: 730, width: 262, height: 120 },
            { width: 560, height: 240 },
            { width: 800, height: 760 }
        ),
        { left: 12, top: 356, placement: 'above' }
    );
});
