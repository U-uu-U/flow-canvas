const test = require('node:test');
const assert = require('node:assert');

let normalizeWheelDelta;
let getCanvasTextFontSize;
let isCanvasTextContentVisible;
let scaleToSliderValue;
let sliderValueToScale;
let wheelZoomFactor;
let zoomViewportAtPoint;

test.before(async () => {
    ({
        getCanvasTextFontSize,
        isCanvasTextContentVisible,
        normalizeWheelDelta,
        scaleToSliderValue,
        sliderValueToScale,
        wheelZoomFactor,
        zoomViewportAtPoint
    } = await import('./viewport-zoom.js'));
});

test('text content: 默认节点一行不足十个汉字时才隐藏', () => {
    assert.equal(isCanvasTextContentVisible(0.43), false);
    assert.equal(isCanvasTextContentVisible(0.44), true);
    assert.equal(isCanvasTextContentVisible(1), true);
});

test('text content: 可见阈值跟随节点真实内容宽度', () => {
    assert.equal(isCanvasTextContentVisible(0.3, 300), false);
    assert.equal(isCanvasTextContentVisible(0.3, 600), true);
    assert.equal(getCanvasTextFontSize(0.3), 11);
});

test('normalizeWheelDelta: 忽略近零和横向滚动', () => {
    assert.equal(normalizeWheelDelta({ deltaX: 0, deltaY: 0 }), 0);
    assert.equal(normalizeWheelDelta({ deltaX: 12, deltaY: 3 }), 0);
    assert.equal(normalizeWheelDelta({ deltaX: 0, deltaY: 0.001 }), 0);
});

test('normalizeWheelDelta: 统一像素、行和页单位并限制单事件输入', () => {
    assert.equal(normalizeWheelDelta({ deltaX: 0, deltaY: 100, deltaMode: 0 }), 100);
    assert.equal(normalizeWheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }), 48);
    assert.equal(normalizeWheelDelta({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 900), 240);
    assert.equal(normalizeWheelDelta({ deltaX: 0, deltaY: -9999, deltaMode: 0 }), -240);
});

test('wheelZoomFactor: 方向正确且单帧不超过百分之二十', () => {
    assert.ok(wheelZoomFactor(-100) > 1);
    assert.ok(wheelZoomFactor(100) < 1);
    assert.equal(wheelZoomFactor(-10000), 1.2);
    assert.equal(wheelZoomFactor(10000), 1 / 1.2);
});

test('zoomViewportAtPoint: 缩放前后鼠标下方的世界坐标保持不变', () => {
    const viewport = { x: -320, y: 140, scale: 0.75 };
    const pointer = { x: 640, y: 360 };
    const before = {
        x: (pointer.x - viewport.x) / viewport.scale,
        y: (pointer.y - viewport.y) / viewport.scale
    };
    const next = zoomViewportAtPoint(viewport, pointer, 1.2);
    const after = {
        x: (pointer.x - next.x) / next.scale,
        y: (pointer.y - next.y) / next.scale
    };

    assert.ok(Math.abs(after.x - before.x) < 1e-9);
    assert.ok(Math.abs(after.y - before.y) < 1e-9);
});

test('zoomViewportAtPoint: 遵守整体缩放边界', () => {
    assert.equal(zoomViewportAtPoint({ x: 0, y: 0, scale: 31.9 }, { x: 50, y: 50 }, 1.2).scale, 32);
    assert.equal(zoomViewportAtPoint({ x: 0, y: 0, scale: 0.11 }, { x: 50, y: 50 }, 0.5).scale, 0.1);
});

test('zoom slider: logarithmic mapping preserves useful control around 100%', () => {
    const oneHundredPercent = scaleToSliderValue(1);
    assert.ok(oneHundredPercent > 300 && oneHundredPercent < 500);
    assert.ok(Math.abs(sliderValueToScale(oneHundredPercent) - 1) < 0.01);
    assert.equal(sliderValueToScale(0), 0.1);
    assert.equal(sliderValueToScale(1000), 32);
});
