import test from 'node:test';
import assert from 'node:assert';

let curvePoints;
let getCompatibleNodeOptions;
let boxIntersectsViewport;
let viewportFixedScale;

test.before(async () => {
    ({ curvePoints, getCompatibleNodeOptions, boxIntersectsViewport, viewportFixedScale } = await import('./graph-view.js'));
});

test('viewportFixedScale: 抵消画布缩放并保持屏幕尺寸', () => {
    assert.equal(viewportFixedScale(0.25), 4);
    assert.equal(viewportFixedScale(1), 1);
    assert.equal(viewportFixedScale(2), 0.5);
    assert.equal(viewportFixedScale(2, 2), 1);
});

test('getCompatibleNodeOptions: 文本输出只列出可接收文本的节点', () => {
    const options = getCompatibleNodeOptions({
        side: 'out',
        port: { name: 'text', dataType: 'string' }
    });

    assert.deepStrictEqual(options.map(option => option.nodeType), ['text', 'image', 'video', 'batch']);
    assert.deepStrictEqual(options.map(option => option.port.name), ['context', 'source', 'source', 'prompt']);
});

test('getCompatibleNodeOptions: 优先选择精确类型端口', () => {
    const options = getCompatibleNodeOptions({
        side: 'out',
        port: { name: 'image', dataType: 'image' }
    });
    const byType = new Map(options.map(option => [option.nodeType, option.port.name]));

    assert.strictEqual(byType.get('image'), 'source');
    assert.strictEqual(byType.get('video'), 'source');
    assert.strictEqual(byType.get('text'), 'context');
    assert.ok(!byType.has('batch'));
});

test('getCompatibleNodeOptions: 从图片节点统一输入反向拖线时提供文本和图片输出节点', () => {
    const options = getCompatibleNodeOptions({
        side: 'in',
        port: { name: 'source', dataType: 'any', accepts: ['string', 'image'] }
    });

    assert.deepStrictEqual(options.map(option => option.nodeType), ['text', 'image', 'batch']);
    assert.deepStrictEqual(options.map(option => option.port.name), ['text', 'image', 'prompts']);
});

test('curvePoints: 保持水平切线并固定首尾锚点', () => {
    const points = curvePoints({ x: 0, y: 20 }, { x: 400, y: 140 });

    assert.deepStrictEqual([points[0], points[1], points[6], points[7]], [0, 20, 400, 140]);
    assert.strictEqual(points[3], 20);
    assert.strictEqual(points[5], 140);
    assert.ok(points[2] > points[0]);
    assert.ok(points[4] < points[6]);
});

test('curvePoints: 高度差越大，线缆曲率越松弛', () => {
    const shallow = curvePoints({ x: 0, y: 0 }, { x: 200, y: 20 });
    const tall = curvePoints({ x: 0, y: 0 }, { x: 200, y: 500 });

    assert.ok(tall[2] > shallow[2]);
});

test('boxIntersectsViewport: 仅保留可见或边缘缓冲区内节点', () => {
    const viewport = { x: 100, y: 100, width: 400, height: 300 };
    assert.equal(boxIntersectsViewport({ x: 120, y: 140, width: 80, height: 60 }, viewport), true);
    assert.equal(boxIntersectsViewport({ x: 520, y: 140, width: 80, height: 60 }, viewport), false);
    assert.equal(boxIntersectsViewport({ x: 520, y: 140, width: 80, height: 60 }, viewport, 40), true);
});
