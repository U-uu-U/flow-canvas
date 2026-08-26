import test from 'node:test';
import assert from 'node:assert/strict';

import {
    cropRectToPixels,
    getOrientedImageSize,
    moveCropRect,
    normalizeCropRect,
    resizeCropRect
} from './image-crop-layout.js';

test('crop rectangles stay inside the source and respect minimum dimensions', () => {
    assert.deepEqual(
        normalizeCropRect({ x: 0.9, y: -0.2, width: 0.4, height: 0.01 }, { minHeight: 0.1 }),
        { x: 0.6, y: 0, width: 0.4, height: 0.1 }
    );
});

test('moving a crop keeps its size while clamping at image edges', () => {
    assert.deepEqual(
        moveCropRect({ x: 0.2, y: 0.25, width: 0.5, height: 0.4 }, 0.7, -0.5),
        { x: 0.5, y: 0, width: 0.5, height: 0.4 }
    );
});

test('edge and corner handles resize around the opposite edge', () => {
    assert.deepEqual(
        resizeCropRect({ x: 0.2, y: 0.2, width: 0.6, height: 0.6 }, 'nw', 0.15, 0.1),
        { x: 0.35, y: 0.3, width: 0.45, height: 0.5 }
    );
    assert.deepEqual(
        resizeCropRect({ x: 0.2, y: 0.2, width: 0.6, height: 0.6 }, 'e', 0.5, 0),
        { x: 0.2, y: 0.2, width: 0.8, height: 0.6 }
    );
});

test('normalized crop coordinates convert to covering oriented pixels', () => {
    assert.deepEqual(
        cropRectToPixels({ x: 0.125, y: 0.1, width: 0.5, height: 0.55 }, 800, 600),
        { left: 100, top: 60, width: 400, height: 330 }
    );
    assert.deepEqual(getOrientedImageSize(4032, 3024, 6), { width: 3024, height: 4032 });
    assert.deepEqual(getOrientedImageSize(4032, 3024, 1), { width: 4032, height: 3024 });
});
