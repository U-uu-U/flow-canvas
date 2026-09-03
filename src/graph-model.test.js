const test = require('node:test');
const assert = require('node:assert');

// graph-model.js 是 ESM（浏览器侧代码），用动态 import 加载。
let G;
test.before(async () => {
    G = await import('./graph-model.js');
});

function media(id, filePath) {
    return { id, kind: 'media', filePath, x: 0, y: 0 };
}

function op(id, nodeType, config = {}) {
    return { id, kind: 'op', nodeType, config, x: 0, y: 0 };
}

function conn(fromId, fromPort, toId, toPort) {
    return {
        id: `${fromId}:${fromPort}->${toId}:${toPort}`,
        from: { nodeId: fromId, port: fromPort },
        to: { nodeId: toId, port: toPort }
    };
}

test('getPorts: media 节点按扩展名推导输出类型', () => {
    assert.deepStrictEqual(G.getPorts(media('m1', 'C:/a/b.png')).outputs,
        [{ name: 'out', dataType: 'image' }]);
    assert.deepStrictEqual(G.getPorts(media('m2', 'C:/a/b.GIF')).outputs,
        [{ name: 'out', dataType: 'image' }]);
    assert.deepStrictEqual(G.getPorts(media('m3', 'C:/a/b.mp4')).outputs,
        [{ name: 'out', dataType: 'video' }]);
    assert.deepStrictEqual(G.getPorts(media('m4', 'C:/a/b.pdf')).outputs,
        [{ name: 'out', dataType: 'file' }]);
    assert.deepStrictEqual(G.getPorts(media('m5', 'C:/a/b.png')).inputs, []);
});

test('getPorts: op 节点读 NODE_TYPES 定义', () => {
    const ports = G.getPorts(op('o1', 'image_gen'));
    assert.deepStrictEqual(ports.inputs, [{ name: 'prompt', dataType: 'string' }]);
    assert.deepStrictEqual(ports.outputs, [{ name: 'image', dataType: 'image' }]);
});

test('getPorts: 未知 nodeType 返回空端口而非抛错', () => {
    assert.deepStrictEqual(G.getPorts(op('o1', 'nope')), { inputs: [], outputs: [] });
    assert.deepStrictEqual(G.getPorts(null), { inputs: [], outputs: [] });
});

test('typesCompatible: any 双向通配', () => {
    assert.ok(G.typesCompatible('image', 'image'));
    assert.ok(G.typesCompatible('any', 'image'));
    assert.ok(G.typesCompatible('image', 'any'));
    assert.ok(!G.typesCompatible('image', 'string'));
    assert.ok(!G.typesCompatible('', 'string'));
});

test('canConnect: 合法连线通过', () => {
    const from = op('t1', 'text_input');
    const to = op('g1', 'image_gen');
    assert.deepStrictEqual(G.canConnect(from, 'text', to, 'prompt', []), { ok: true });
});

test('canConnect: 类型不匹配被拒', () => {
    const from = media('m1', 'a.png');       // out: image
    const to = op('g1', 'image_gen');        // prompt: string
    const res = G.canConnect(from, 'out', to, 'prompt', []);
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /类型不匹配/);
});

test('canConnect: 拒绝自连', () => {
    const node = op('m1', 'text_merge');
    const res = G.canConnect(node, 'merged', node, 'text_a', []);
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /自身/);
});

test('canConnect: 端口不存在被拒', () => {
    const from = op('t1', 'text_input');
    const to = op('g1', 'image_gen');
    assert.strictEqual(G.canConnect(from, 'nope', to, 'prompt', []).ok, false);
    assert.strictEqual(G.canConnect(from, 'text', to, 'nope', []).ok, false);
});

test('canConnect: input 端口已占用时返回待替换的旧连线', () => {
    const a = op('t1', 'text_input');
    const b = op('t2', 'text_input');
    const target = op('g1', 'image_gen');
    const existing = [conn('t1', 'text', 'g1', 'prompt')];

    const res = G.canConnect(b, 'text', target, 'prompt', existing);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.replaces.id, existing[0].id);

    // 完全相同的连线视为重复，不是替换
    const dup = G.canConnect(a, 'text', target, 'prompt', existing);
    assert.strictEqual(dup.ok, false);
    assert.match(dup.reason, /已存在/);
});

test('canConnect: 拒绝直接成环', () => {
    const a = op('a', 'text_merge');
    const b = op('b', 'text_merge');
    const existing = [conn('a', 'merged', 'b', 'text_a')];
    const res = G.canConnect(b, 'merged', a, 'text_a', existing);
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /环形/);
});

test('canConnect: 拒绝间接成环 a→b→c→a', () => {
    const a = op('a', 'text_merge');
    const c = op('c', 'text_merge');
    const existing = [
        conn('a', 'merged', 'b', 'text_a'),
        conn('b', 'merged', 'c', 'text_a')
    ];
    const res = G.canConnect(c, 'merged', a, 'text_a', existing);
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /环形/);
});

test('reachable: 沿连线方向可达性', () => {
    const edges = [conn('a', 'o', 'b', 'i'), conn('b', 'o', 'c', 'i')];
    assert.ok(G.reachable('a', 'c', edges));
    assert.ok(!G.reachable('c', 'a', edges));
    assert.ok(G.reachable('a', 'a', edges));
});

test('topoOrder: 只收集上游闭包，目标节点排最后', () => {
    const items = [
        op('t1', 'text_input'),
        op('t2', 'text_input'),
        op('merge', 'text_merge'),
        op('gen', 'image_gen'),
        op('unrelated', 'text_input')
    ];
    const edges = [
        conn('t1', 'text', 'merge', 'text_a'),
        conn('t2', 'text', 'merge', 'text_b'),
        conn('merge', 'merged', 'gen', 'prompt')
    ];

    const { order, missing } = G.topoOrder('gen', items, edges);
    assert.deepStrictEqual(missing, []);
    assert.strictEqual(order.length, 4);
    assert.ok(!order.includes('unrelated'), '无关节点不应进入执行序');
    assert.strictEqual(order[order.length - 1], 'gen');
    assert.ok(order.indexOf('t1') < order.indexOf('merge'));
    assert.ok(order.indexOf('t2') < order.indexOf('merge'));
    assert.ok(order.indexOf('merge') < order.indexOf('gen'));
});

test('topoOrder: 孤立节点返回自身', () => {
    const items = [op('solo', 'text_input')];
    assert.deepStrictEqual(G.topoOrder('solo', items, []).order, ['solo']);
});

test('topoOrder: 目标不存在时报告 missing', () => {
    const { order, missing } = G.topoOrder('ghost', [], []);
    assert.deepStrictEqual(order, []);
    assert.deepStrictEqual(missing, ['ghost']);
});

test('topoOrder: 连线引用了已删除的上游节点', () => {
    const items = [op('gen', 'image_gen')];
    const edges = [conn('deleted', 'text', 'gen', 'prompt')];
    const { order, missing } = G.topoOrder('gen', items, edges);
    assert.deepStrictEqual(order, ['gen']);
    assert.deepStrictEqual(missing, ['deleted']);
});

test('topoOrder: 接受 Map 形式的 items', () => {
    const map = new Map([['solo', op('solo', 'text_input')]]);
    assert.deepStrictEqual(G.topoOrder('solo', map, []).order, ['solo']);
});

test('topoOrder: 脏数据成环时返回空序并标记 cyclic', () => {
    const items = [op('a', 'text_merge'), op('b', 'text_merge')];
    const edges = [
        conn('a', 'merged', 'b', 'text_a'),
        conn('b', 'merged', 'a', 'text_a')
    ];
    const res = G.topoOrder('a', items, edges);
    assert.deepStrictEqual(res.order, []);
    assert.strictEqual(res.cyclic, true);
});

test('collectInputs: 按端口名从缓存取上游结果', () => {
    const target = op('merge', 'text_merge');
    const edges = [
        conn('t1', 'text', 'merge', 'text_a'),
        conn('t2', 'text', 'merge', 'text_b')
    ];
    const cache = new Map([
        ['t1', { text: 'hello' }],
        ['t2', { text: 'world' }]
    ]);
    assert.deepStrictEqual(G.collectInputs(target, edges, cache),
        { text_a: 'hello', text_b: 'world' });
});

test('collectInputs: 未连接或上游无结果时省略该键', () => {
    const target = op('merge', 'text_merge');
    const edges = [conn('t1', 'text', 'merge', 'text_a')];

    assert.deepStrictEqual(
        G.collectInputs(target, edges, new Map([['t1', { text: 'x' }]])),
        { text_a: 'x' }
    );
    // 上游还没跑出结果
    assert.deepStrictEqual(G.collectInputs(target, edges, new Map()), {});
    // 端口名对不上
    assert.deepStrictEqual(
        G.collectInputs(target, edges, new Map([['t1', { other: 'x' }]])),
        {}
    );
});

test('mediaOutput: 生成 local-res:// URL', () => {
    const out = G.mediaOutput(media('m1', 'C:/图片/a b.png'));
    assert.strictEqual(out.out, 'local-res://' + encodeURIComponent('C:/图片/a b.png'));
    assert.deepStrictEqual(G.mediaOutput(media('m2', '')), {});
});

test('connectionsWithout: 移除节点的进出连线', () => {
    const edges = [
        conn('a', 'o', 'b', 'i'),
        conn('b', 'o', 'c', 'i'),
        conn('a', 'o', 'c', 'i2')
    ];
    const left = G.connectionsWithout('b', edges);
    assert.strictEqual(left.length, 1);
    assert.strictEqual(left[0].id, 'a:o->c:i2');
});

test('downstreamOf: 收集所有间接下游', () => {
    const edges = [
        conn('a', 'o', 'b', 'i'),
        conn('b', 'o', 'c', 'i'),
        conn('x', 'o', 'y', 'i')
    ];
    assert.deepStrictEqual(G.downstreamOf('a', edges).sort(), ['b', 'c']);
    assert.deepStrictEqual(G.downstreamOf('c', edges), []);
});
