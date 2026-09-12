import test from 'node:test';
import assert from 'node:assert/strict';
import { getUiCompensationScale, getUiScreenScale, normalizeUiScaleLimit, readUiScaleLimit } from './canvas-ui-scale.js';

test('UI scaling shrinks ports and line widths together beyond the compensation cap', () => {
    for (const limit of [1, 2, 4, 6]) {
        for (const zoom of [0.02, 0.1, 0.25, 0.5, 1, 2, 8]) {
            const compensation = getUiCompensationScale(zoom, limit);
            assert.ok(compensation <= limit);
            assert.equal(compensation * zoom, getUiScreenScale(zoom, limit));
            assert.ok(getUiScreenScale(zoom, limit) <= 1);
        }
    }
    assert.equal(getUiScreenScale(0.25, 2), 0.5);
    assert.equal(getUiScreenScale(0.25, 4), 1);
    assert.equal(getUiScreenScale(2, 2), 1);
});

test('UI scaling remains continuous at the threshold', () => {
    const below = getUiScreenScale(0.4999, 2);
    const above = getUiScreenScale(0.5001, 2);
    assert.ok(Math.abs(above - below) < 0.001);
});

test('UI preference accepts saved values and recovers from missing or invalid storage', () => {
    assert.equal(readUiScaleLimit({ getItem: () => '3.2' }), 3.2);
    assert.equal(readUiScaleLimit({ getItem: () => null }), 2);
    assert.equal(readUiScaleLimit({ getItem: () => { throw new Error('unavailable'); } }), 2);
    for (const value of [null, '', 'invalid', Infinity, -1]) assert.equal(normalizeUiScaleLimit(value), 2);
    assert.equal(normalizeUiScaleLimit(0.5), 1);
    assert.equal(normalizeUiScaleLimit(99), 6);
});
