import test from 'node:test';
import assert from 'node:assert';

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
    // media 的 source 输入可以承接多条溯源或参考边
    assert.deepStrictEqual(G.getPorts(media('m5', 'C:/a/b.png')).inputs,
        [{ name: 'source', dataType: 'any', multi: true }]);
});

test('getPorts: 空媒体节点按持久化 mediaType 推导输出类型', () => {
    assert.deepEqual(G.getPorts({ id: 'empty-image', mediaType: 'image', filePath: '' }).outputs, [
        { name: 'out', dataType: 'image' }
    ]);
    assert.deepEqual(G.getPorts({ id: 'audio', mediaType: 'audio', filePath: 'voice.wav' }).outputs, [
        { name: 'out', dataType: 'file' }
    ]);
});

test('convertGeneratorOutputConnections: 输入改为溯源线，输出改接普通素材端口', () => {
    const connections = [
        conn('reference', 'out', 'generator', 'source'),
        conn('prompt', 'text', 'generator', 'source'),
        conn('generator', 'image', 'video', 'source'),
        conn('other', 'out', 'target', 'source')
    ];

    const converted = G.convertGeneratorOutputConnections(connections, 'generator');
    assert.equal(converted[0].kind, 'history');
    assert.equal(converted[0].to.port, 'source');
    assert.equal(converted[1].kind, 'history');
    assert.equal(converted[2].from.port, 'out');
    assert.deepStrictEqual(converted[3], connections[3]);
});

test('getPorts: op 节点读 NODE_TYPES 定义', () => {
    const ports = G.getPorts(op('o1', 'image'));
    assert.deepStrictEqual(ports.inputs, [
        { name: 'source', dataType: 'any', accepts: ['string', 'image'], multi: true }
    ]);
    assert.deepStrictEqual(ports.outputs, [{ name: 'image', dataType: 'image' }]);

    assert.deepStrictEqual(G.getPorts(op('v1', 'video')).inputs, [
        { name: 'source', dataType: 'any', accepts: ['string', 'image', 'video', 'file'], multi: true }
    ]);
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
    const from = op('t1', 'text');
    const to = op('g1', 'image');
    assert.deepStrictEqual(G.canConnect(from, 'text', to, 'source', []), { ok: true });
});

test('canConnect: 类型不匹配被拒', () => {
    const from = media('m1', 'a.mp4');
    const to = op('g1', 'image');
    const res = G.canConnect(from, 'out', to, 'source', []);
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /类型不匹配/);
});

test('canConnect: 拒绝自连', () => {
    const node = op('m1', 'text');
    const res = G.canConnect(node, 'merged', node, 'text_a', []);
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /自身/);
});

test('canConnect: 端口不存在被拒', () => {
    const from = op('t1', 'text');
    const to = op('g1', 'image');
    assert.strictEqual(G.canConnect(from, 'nope', to, 'prompt', []).ok, false);
    assert.strictEqual(G.canConnect(from, 'text', to, 'nope', []).ok, false);
});

test('canConnect: 普通图片 source 端口允许多条参考连线', () => {
    const b = media('b', 'b.png');
    const target = media('target', 'target.png');
    const existing = [conn('a', 'out', 'target', 'source')];
    const res = G.canConnect(b, 'out', target, 'source', existing);
    assert.deepStrictEqual(res, { ok: true });
});

test('canConnect: 拒绝直接成环', () => {
    const a = op('a', 'text');
    const b = op('b', 'text');
    const existing = [conn('a', 'text', 'b', 'context')];
    const res = G.canConnect(b, 'text', a, 'context', existing);
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /环形/);
});

test('canConnect: 拒绝间接成环 a→b→c→a', () => {
    const a = op('a', 'text');
    const c = op('c', 'text');
    const existing = [
        conn('a', 'text', 'b', 'context'),
        conn('b', 'text', 'c', 'context')
    ];
    const res = G.canConnect(c, 'text', a, 'context', existing);
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
        op('t1', 'text'),
        op('t2', 'text'),
        op('merge', 'text'),
        op('gen', 'image'),
        op('unrelated', 'text')
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
    const items = [op('solo', 'text')];
    assert.deepStrictEqual(G.topoOrder('solo', items, []).order, ['solo']);
});

test('topoOrder: history 溯源边不参与执行依赖', () => {
    const source = op('source', 'image');
    const result = media('result', 'C:/output/result.png');
    const history = {
        ...conn('source', 'image', 'result', 'source'),
        kind: 'history'
    };

    assert.deepStrictEqual(G.topoOrder('result', [source, result], [history]).order, ['result']);
    assert.deepStrictEqual(G.downstreamOf('source', [history]), []);
});

test('topoOrder: 目标不存在时报告 missing', () => {
    const { order, missing } = G.topoOrder('ghost', [], []);
    assert.deepStrictEqual(order, []);
    assert.deepStrictEqual(missing, ['ghost']);
});

test('topoOrder: 连线引用了已删除的上游节点', () => {
    const items = [op('gen', 'image')];
    const edges = [conn('deleted', 'text', 'gen', 'prompt')];
    const { order, missing } = G.topoOrder('gen', items, edges);
    assert.deepStrictEqual(order, ['gen']);
    assert.deepStrictEqual(missing, ['deleted']);
});

test('topoOrder: 接受 Map 形式的 items', () => {
    const map = new Map([['solo', op('solo', 'text')]]);
    assert.deepStrictEqual(G.topoOrder('solo', map, []).order, ['solo']);
});

test('topoOrder: 脏数据成环时返回空序并标记 cyclic', () => {
    const items = [op('a', 'text'), op('b', 'text')];
    const edges = [
        conn('a', 'merged', 'b', 'text_a'),
        conn('b', 'merged', 'a', 'text_a')
    ];
    const res = G.topoOrder('a', items, edges);
    assert.deepStrictEqual(res.order, []);
    assert.strictEqual(res.cyclic, true);
});

test('collectInputs: 按端口名从缓存取上游结果', () => {
    const target = op('merge', 'text');
    const edges = [
        conn('t1', 'text', 'merge', 'context'),
        conn('t2', 'text', 'merge', 'context')
    ];
    const cache = new Map([
        ['t1', { text: 'hello' }],
        ['t2', { text: 'world' }]
    ]);
    // context 是 multi 端口，多条上游聚成数组
    assert.deepStrictEqual(G.collectInputs(target, edges, cache),
        { context: ['hello', 'world'] });
});

test('collectInputs: 未连接或上游无结果时省略该键', () => {
    const target = op('merge', 'text');
    const edges = [conn('t1', 'text', 'merge', 'context')];

    assert.deepStrictEqual(
        G.collectInputs(target, edges, new Map([['t1', { text: 'x' }]])),
        { context: ['x'] }
    );
    // 上游还没跑出结果
    assert.deepStrictEqual(G.collectInputs(target, edges, new Map()), {});
    // 端口名对不上
    assert.deepStrictEqual(
        G.collectInputs(target, edges, new Map([['t1', { other: 'x' }]])),
        {}
    );
});

test('collectInputs: 统一端口收集文本和多种素材并兼容旧端口名', () => {
    const target = op('gen', 'image');
    const edges = [
        conn('a', 'image', 'gen', 'reference'),
        conn('b', 'image', 'gen', 'reference'),
        conn('p', 'text', 'gen', 'prompt')
    ];
    const cache = new Map([
        ['a', { image: 'local-res://a.png' }],
        ['b', { image: 'local-res://b.png' }],
        ['p', { text: '一只猫' }]
    ]);
    const got = G.collectInputs(target, edges, cache);
    assert.deepStrictEqual(got.source, ['local-res://a.png', 'local-res://b.png', '一只猫']);
});

test('collectInputs: 历史父节点只保留链路，不会成为新生成任务的引用', () => {
    const target = op('next-video', 'video');
    const originalReference = conn('original-image', 'out', 'next-video', 'source');
    const historyParent = {
        ...conn('previous-video', 'video', 'next-video', 'source'),
        kind: 'history'
    };
    const cache = new Map([
        ['original-image', { out: 'local-res://original.png' }],
        ['previous-video', { video: 'local-res://previous.mp4' }]
    ]);

    assert.deepStrictEqual(
        G.collectInputs(target, [historyParent, originalReference], cache),
        { source: ['local-res://original.png'] }
    );
});

test('collectInputContext: 保留连接 ID、来源节点、素材尺寸和原始值', () => {
    const source = {
        ...media('image-a', 'C:/refs/a.png'),
        fromNodeId: 'older-generator',
        mediaType: 'image',
        width: 300,
        height: 450
    };
    const target = op('gen', 'image');
    const edge = conn('image-a', 'out', 'gen', 'source');
    const cache = new Map([['image-a', { out: 'local-res://' + encodeURIComponent('C:/refs/a.png') }]]);
    const context = G.collectInputContext(target, [edge], cache, [source, target]);

    assert.deepStrictEqual(context, [{
        connectionId: edge.id,
        connectionIndex: 0,
        sourceNodeId: 'image-a',
        sourcePort: 'out',
        targetPort: 'source',
        values: ['local-res://' + encodeURIComponent('C:/refs/a.png')],
        source: {
            id: 'image-a',
            kind: 'media',
            nodeType: null,
            filePath: 'C:/refs/a.png',
            fromNodeId: 'older-generator',
            mediaType: 'image',
            width: 300,
            height: 450
        }
    }]);
});

test('canConnect: multi 端口允许多条连线，不触发替换', () => {
    const b = media('b', 'b.png');
    const gen = op('gen', 'image');
    const existing = [conn('a', 'out', 'gen', 'source')];
    const res = G.canConnect(b, 'out', gen, 'source', existing);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.replaces, undefined);
});

test('normalizeGeneratorInputConnections: 旧生成端口迁移为单一 source 并去重', () => {
    const items = [op('gen', 'image'), op('video-gen', 'video')];
    const normalized = G.normalizeGeneratorInputConnections([
        conn('p', 'text', 'gen', 'prompt'),
        conn('a', 'out', 'gen', 'reference'),
        conn('a', 'out', 'gen', 'source'),
        conn('v', 'out', 'video-gen', 'video')
    ], items);

    assert.deepStrictEqual(normalized.map(connection => connection.to.port), ['source', 'source', 'source']);
    assert.deepStrictEqual(normalized.map(connection => connection.from.nodeId), ['p', 'a', 'v']);
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
