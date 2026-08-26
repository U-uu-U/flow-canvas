import test from 'node:test';
import assert from 'node:assert/strict';

import { getSelectionToolbarPosition } from './selection-toolbar-layout.js';

test('selection toolbar stays centered above a selected asset across canvas zoom', () => {
    const common = {
        viewport: { width: 1200, height: 800 },
        toolbar: { width: 420, height: 48 },
        itemRect: { x: 300, y: 240, width: 300, height: 200 }
    };
    const normal = getSelectionToolbarPosition({ ...common, stage: { x: 0, y: 0, scale: 1 } });
    const zoomed = getSelectionToolbarPosition({ ...common, stage: { x: -150, y: -120, scale: 1.5 } });

    assert.equal(normal.left, 240);
    assert.equal(normal.top, 158);
    assert.equal(normal.placement, 'above');
    assert.equal(zoomed.left, 315);
    assert.equal(zoomed.top, 158);
    assert.equal(zoomed.placement, 'above');
});

test('selection toolbar moves below assets near the viewport top and clamps horizontally', () => {
    const position = getSelectionToolbarPosition({
        stage: { x: 0, y: 0, scale: 1 },
        itemRect: { x: -80, y: 8, width: 160, height: 100 },
        viewport: { width: 500, height: 320 },
        toolbar: { width: 420, height: 48 }
    });

    assert.deepEqual(position, {
        left: 10,
        top: 142,
        placement: 'below',
        visible: true
    });
});

test('selection toolbar reports offscreen assets as hidden', () => {
    const position = getSelectionToolbarPosition({
        stage: { x: -1200, y: 0, scale: 1 },
        itemRect: { x: 100, y: 100, width: 300, height: 200 },
        viewport: { width: 800, height: 600 },
        toolbar: { width: 420, height: 48 }
    });

    assert.equal(position.visible, false);
});
