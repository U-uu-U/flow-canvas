import test from 'node:test';
import assert from 'node:assert/strict';

let getVideoControlLayout;
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test.before(async () => {
    ({ getVideoControlLayout } = await import('./video-control-layout.js'));
});

test('video controls keep fixed screen dimensions across canvas zoom', () => {
    [0.5, 1, 3].forEach(scale => {
        const layout = getVideoControlLayout(scale, 640, 360);
        closeTo(layout.controlHeight * scale, 28);
        closeTo(layout.backgroundHeight * scale, 22);
        closeTo(layout.progressHeight * scale, 4);
        closeTo(layout.progressX * scale, 61);
        closeTo(layout.glyphCenterY * scale, 14);
        closeTo(layout.playCenterX * scale, 14);
        closeTo(layout.volumeCenterX * scale, 42);
        closeTo(layout.glyphScale * 24 * scale, 18);
    });
});

test('video timeline shares the button center line and stays inside the video', () => {
    const layout = getVideoControlLayout(2.5, 300, 180);
    assert.equal(layout.progressY + layout.progressHeight / 2, layout.glyphCenterY);
    assert.equal(layout.groupY + layout.controlHeight, 180);
    assert.ok(layout.progressWidth > 0);
    assert.ok(layout.progressX + layout.progressWidth <= 300);
});

test('video buttons, background and timeline shrink together at the UI compensation cap', () => {
    for (const limit of [1, 2, 6]) {
        const scale = 0.25;
        const layout = getVideoControlLayout(scale, 640, 360, limit);
        const screenScale = Math.min(1, scale * limit);
        closeTo(layout.controlHeight * scale, 28 * screenScale);
        closeTo(layout.glyphScale * 24 * scale, 18 * screenScale);
        closeTo(layout.backgroundHeight * scale, 22 * screenScale);
        closeTo(layout.progressHeight * scale, 4 * screenScale);
        closeTo(layout.progressY + layout.progressHeight / 2, layout.glyphCenterY);
        closeTo(layout.groupY + layout.controlHeight, 360);
        closeTo(layout.progressX + layout.progressWidth + 8 * Math.min(1 / scale, limit), 640);
        assert.equal(getVideoControlLayout(0.09, 640, 360, limit).visible, false);
    }
});

test('video controls hide when the on-screen media cannot fit both buttons', () => {
    assert.equal(getVideoControlLayout(0.1, 640, 360).visible, true);
    assert.equal(getVideoControlLayout(0.09, 640, 360).visible, false);
    assert.equal(getVideoControlLayout(1, 63, 100).visible, false);
    assert.equal(getVideoControlLayout(1, 200, 35).visible, false);
    assert.equal(getVideoControlLayout(0.25, 640, 360).visible, true);
});
