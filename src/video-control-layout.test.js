import test from 'node:test';
import assert from 'node:assert/strict';

let getVideoControlLayout;

test.before(async () => {
    ({ getVideoControlLayout } = await import('./video-control-layout.js'));
});

test('video controls keep fixed screen dimensions across canvas zoom', () => {
    [0.5, 1, 3].forEach(scale => {
        const layout = getVideoControlLayout(scale, 640, 360);
        assert.equal(layout.controlHeight * scale, 28);
        assert.equal(layout.backgroundHeight * scale, 22);
        assert.equal(layout.progressHeight * scale, 4);
        assert.equal(layout.progressX * scale, 61);
        assert.equal(layout.glyphCenterY * scale, 14);
        assert.equal(layout.playCenterX * scale, 14);
        assert.equal(layout.volumeCenterX * scale, 42);
    });
});

test('video timeline shares the button center line and stays inside the video', () => {
    const layout = getVideoControlLayout(2.5, 300, 180);
    assert.equal(layout.progressY + layout.progressHeight / 2, layout.glyphCenterY);
    assert.equal(layout.groupY + layout.controlHeight, 180);
    assert.ok(layout.progressWidth > 0);
    assert.ok(layout.progressX + layout.progressWidth <= 300);
});

test('video controls hide when the on-screen media cannot fit both buttons', () => {
    assert.equal(getVideoControlLayout(0.1, 640, 360).visible, true);
    assert.equal(getVideoControlLayout(0.09, 640, 360).visible, false);
    assert.equal(getVideoControlLayout(1, 63, 100).visible, false);
    assert.equal(getVideoControlLayout(1, 200, 35).visible, false);
    assert.equal(getVideoControlLayout(0.25, 640, 360).visible, true);
});
