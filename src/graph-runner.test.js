import test from 'node:test';
import assert from 'node:assert/strict';

let R, NT;
test.before(async () => {
    R = await import('./graph-runner.js');
    NT = (await import('./node-types.js')).NODE_TYPES;
});

function makeCtx(items, connections = []) {
    const statusLog = [];
    return {
        items,
        connections,
        statusLog,
        getItems: () => items,
        getConnections: () => connections,
        onStatus: id => {
            const it = items.find(i => i.id === id);
            statusLog.push(`${id}:${it.runStatus}`);
        }
    };
}

const op = (id, nodeType, config = {}) => ({ id, kind: 'op', nodeType, config, x: 0, y: 0 });
const media = (id, filePath) => ({ id, kind: 'media', filePath, x: 0, y: 0 });
const conn = (f, fp, t, tp) => ({
    id: `${f}->${t}`, from: { nodeId: f, port: fp }, to: { nodeId: t, port: tp }
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function mockGenerationBridge(t, mcp) {
    const previousWindow = globalThis.window;
    globalThis.window = { flowCanvas: { mcp } };
    t.after(() => {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    });
}

test('runFrom: 单个文本节点执行成功', async () => {
    const items = [op('t1', 'text', { text: 'hello' })];
    const ctx = makeCtx(items);
    const runner = new R.GraphRunner(ctx);

    const res = await runner.runFrom('t1');
    assert.equal(res.ok, true);
    assert.deepEqual(res.ran, ['t1']);
    assert.equal(items[0].runStatus, R.STATUS.DONE);
    assert.deepEqual(runner.getResult('t1'), { text: 'hello' });
});

test('runFrom: 链式执行按拓扑序，结果向下游传递', async () => {
    const items = [
        op('a', 'text', { text: 'foo' }),
        op('b', 'text', { text: 'bar' }),
        op('m', 'text', { separator: ' + ' })
    ];
    // 合并职责已并入 text 节点的 context 端口（multi），不再有独立的合并节点
    const edges = [conn('a', 'text', 'm', 'context'), conn('b', 'text', 'm', 'context')];
    const ctx = makeCtx(items, edges);
    const runner = new R.GraphRunner(ctx);

    const res = await runner.runFrom('m');
    assert.equal(res.ok, true);
    assert.deepEqual(runner.getResult('m'), { text: 'foo + bar' });
    assert.equal(items[2].runStatus, R.STATUS.DONE);
    assert.equal(items[0].runStatus, undefined, '读取普通文本不修改上游状态');
    assert.equal(items[1].runStatus, undefined, '读取普通文本不修改上游状态');
});

test('runFrom: 只跑上游闭包，无关节点保持 idle', async () => {
    const items = [
        op('a', 'text', { text: 'x' }),
        op('unrelated', 'text', { text: 'y' })
    ];
    const ctx = makeCtx(items);
    const runner = new R.GraphRunner(ctx);

    await runner.runFrom('a');
    assert.equal(items[1].runStatus, undefined, '无关节点不应被触碰');
});

test('runFrom: media 节点输出 local-res URL', async () => {
    const items = [media('m1', 'C:/图片/a.png')];
    const ctx = makeCtx(items);
    const runner = new R.GraphRunner(ctx);

    const res = await runner.runFrom('m1');
    assert.equal(res.ok, true);
    assert.equal(runner.getResult('m1').out,
        'local-res://' + encodeURIComponent('C:/图片/a.png'));
});

test('runFrom: 状态流转经过 queued → running → done', async () => {
    const items = [op('t1', 'text', { text: 'x' })];
    const ctx = makeCtx(items);
    await new R.GraphRunner(ctx).runFrom('t1');
    assert.deepEqual(ctx.statusLog, ['t1:queued', 't1:running', 't1:done']);
});

test('runFrom: 节点抛错时标 error 并级联标记下游', async () => {
    // text_merge 不会抛错，用一个临时注册的会抛错的类型
    NT.__test_boom = {
        type: '__test_boom', title: '炸弹', icon: '💥', color: '#f00', width: 100,
        inputs: [], outputs: [{ name: 'out', dataType: 'string' }], config: [],
        async execute() { throw new Error('故意失败'); }
    };
    NT.__test_sink = {
        type: '__test_sink', title: '接收', icon: '🪣', color: '#0f0', width: 100,
        inputs: [{ name: 'in', dataType: 'string' }], outputs: [{ name: 'out', dataType: 'string' }],
        config: [],
        async execute(inputs) { return { out: inputs.in }; }
    };

    const items = [op('boom', '__test_boom'), op('sink', '__test_sink')];
    const edges = [conn('boom', 'out', 'sink', 'in')];
    const ctx = makeCtx(items, edges);
    const runner = new R.GraphRunner(ctx);

    const res = await runner.runFrom('sink');
    assert.equal(res.ok, false);
    assert.equal(res.reason, '故意失败');
    assert.equal(res.failedAt, 'boom');
    assert.equal(items[0].runStatus, R.STATUS.ERROR);
    assert.equal(items[0].runError, '故意失败');
    assert.equal(items[1].runStatus, R.STATUS.ERROR);
    assert.match(items[1].runError, /上游节点「炸弹」执行失败/);

    delete NT.__test_boom;
    delete NT.__test_sink;
});

test('runFrom: 未知节点类型报错', async () => {
    const items = [op('x', 'does_not_exist')];
    const ctx = makeCtx(items);
    const res = await new R.GraphRunner(ctx).runFrom('x');
    assert.equal(res.ok, false);
    assert.match(res.reason, /未知节点类型/);
});

test('runFrom: 目标节点不存在', async () => {
    const res = await new R.GraphRunner(makeCtx([])).runFrom('ghost');
    assert.equal(res.ok, false);
    assert.match(res.reason, /节点不存在/);
});

test('runFrom: 同一节点链防重复，互不相干的链可并发', async () => {
    const releases = new Map();
    NT.__test_slow = {
        type: '__test_slow', title: '慢', icon: '🐢', color: '#00f', width: 100,
        inputs: [], outputs: [{ name: 'out', dataType: 'string' }], config: [],
        execute: (_inputs, _config, ctx) => new Promise(resolve => {
            releases.set(ctx.item.id, () => resolve({ out: ctx.item.id }));
        })
    };

    const items = [op('s1', '__test_slow'), op('s2', '__test_slow')];
    const runner = new R.GraphRunner(makeCtx(items));

    const first = runner.runFrom('s1');
    const duplicate = await runner.runFrom('s1');
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.reason, /节点链正在执行/);

    const independent = runner.runFrom('s2');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(items[0].runStatus, R.STATUS.RUNNING);
    assert.equal(items[1].runStatus, R.STATUS.RUNNING);

    releases.get('s2')();
    releases.get('s1')();
    assert.equal((await independent).ok, true);
    assert.equal((await first).ok, true);
    assert.deepEqual(runner.getResult('s1'), { out: 's1' });
    assert.deepEqual(runner.getResult('s2'), { out: 's2' });

    delete NT.__test_slow;
});

test('cancel: 中断运行节点并丢弃迟到结果', async () => {
    let release;
    NT.__test_cancelable = {
        type: '__test_cancelable', title: '可中断', icon: 'stop', color: '#777', width: 100,
        inputs: [], outputs: [{ name: 'out', dataType: 'string' }], config: [],
        execute: () => new Promise(resolve => { release = resolve; })
    };
    const items = [op('cancel-me', '__test_cancelable')];
    const landed = [];
    const ctx = {
        ...makeCtx(items),
        onResult: (_item, output) => landed.push(output),
        cancelGenerationTasks: async nodeId => {
            assert.equal(nodeId, 'cancel-me');
            release({ out: 'late result' });
        }
    };
    const runner = new R.GraphRunner(ctx);
    const pending = runner.runFrom('cancel-me');
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(await runner.cancel('cancel-me'), true);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.canceled, true);
    assert.equal(items[0].runStatus, R.STATUS.CANCELED);
    assert.equal(runner.getResult('cancel-me'), null);
    assert.deepEqual(landed, []);
    assert.equal(await runner.cancel('cancel-me'), false);

    delete NT.__test_cancelable;
});

test('runFrom: 共享正在执行的上游任务时拒绝重复执行', async () => {
    let release;
    NT.__test_shared_slow = {
        type: '__test_shared_slow', title: '共享慢节点', icon: 'clock', color: '#00f', width: 100,
        inputs: [], outputs: [{ name: 'out', dataType: 'string' }], config: [],
        execute: () => new Promise(resolve => { release = () => resolve({ out: 'shared' }); })
    };
    NT.__test_sink = {
        type: '__test_sink', title: '接收', icon: 'inbox', color: '#0f0', width: 100,
        inputs: [{ name: 'in', dataType: 'string' }], outputs: [{ name: 'out', dataType: 'string' }],
        config: [], async execute(inputs) { return { out: inputs.in }; }
    };

    const items = [
        op('shared', '__test_shared_slow'),
        op('left', '__test_sink'),
        op('right', '__test_sink')
    ];
    const edges = [
        conn('shared', 'out', 'left', 'in'),
        conn('shared', 'out', 'right', 'in')
    ];
    const runner = new R.GraphRunner(makeCtx(items, edges));
    const first = runner.runFrom('left');
    const second = await runner.runFrom('right');
    assert.equal(second.ok, false);
    assert.match(second.reason, /节点链正在执行/);

    release();
    assert.equal((await first).ok, true);
    delete NT.__test_shared_slow;
    delete NT.__test_sink;
});

for (const sourceKind of ['media', 'text', 'product']) {
    test(`runFrom: parallel video branches can share ${sourceKind} without sharing cancellation`, async t => {
        const originalVideo = NT.video;
        const releases = new Map();
        const received = new Map();
        NT.video = {
            ...originalVideo,
            execute: (inputs, _config, ctx) => new Promise(resolve => {
                received.set(ctx.item.id, inputs);
                releases.set(ctx.item.id, () => resolve({ video: `${ctx.item.id}.mp4` }));
            })
        };
        t.after(() => { NT.video = originalVideo; });
        const source = sourceKind === 'media'
            ? media('source', 'C:/shared.png')
            : sourceKind === 'text'
                ? op('source', 'text', { text: 'shared prompt' })
                : { ...op('source', 'image'), resultEntries: [{ filePath: 'C:/shared.png' }] };
        source.runStatus = R.STATUS.DONE;
        const sourceBefore = structuredClone(source);
        const sourcePort = sourceKind === 'text' ? 'text' : sourceKind === 'media' ? 'out' : 'image';
        const targetPort = 'source';
        const items = [source, op('left', 'video'), op('right', 'video')];
        const ctx = makeCtx(items, [
            conn('source', sourcePort, 'left', targetPort),
            conn('source', sourcePort, 'right', targetPort)
        ]);
        const landed = [];
        const canceled = [];
        ctx.onResult = item => landed.push(item.id);
        ctx.cancelGenerationTasks = id => { canceled.push(id); releases.get(id)?.(); };
        const runner = new R.GraphRunner(ctx);
        const first = runner.runFrom('left');
        const second = runner.runFrom('right');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual([...received.keys()], ['left', 'right']);
        const expected = sourceKind === 'text' ? ['shared prompt'] : ['local-res://' + encodeURIComponent('C:/shared.png')];
        for (const inputs of received.values()) {
            assert.deepEqual([inputs[targetPort]].flat(), expected);
        }
        assert.deepEqual([...runner.activeNodes], ['left', 'right']);
        assert.equal((await runner.runFrom('left')).ok, false, 'same node must not submit twice');
        assert.equal(await runner.cancel('source'), false, 'shared input must not cancel an arbitrary branch');
        assert.equal(await runner.cancel('left'), true);
        assert.equal((await first).canceled, true);
        assert.deepEqual(canceled, ['left']);
        assert.equal(items[2].runStatus, R.STATUS.RUNNING);
        releases.get('right')();
        assert.equal((await second).ok, true);
        assert.deepEqual(landed, ['right']);
        assert.deepEqual(source, sourceBefore);
        assert.equal(runner.activeNodes.size, 0);
    });
}

test('runFrom: a failed branch does not change a parallel branch or its shared input', async t => {
    const originalVideo = NT.video;
    const pending = new Map();
    NT.video = { ...originalVideo, execute: (_inputs, _config, ctx) => new Promise((resolve, reject) => {
        pending.set(ctx.item.id, { resolve, reject });
    }) };
    t.after(() => { NT.video = originalVideo; });
    const source = media('source', 'C:/shared.png');
    const items = [source, op('left', 'video'), op('right', 'video')];
    const ctx = makeCtx(items, [conn('source', 'out', 'left', 'source'), conn('source', 'out', 'right', 'source')]);
    const runner = new R.GraphRunner(ctx);
    const first = runner.runFrom('left');
    const second = runner.runFrom('right');
    await new Promise(resolve => setImmediate(resolve));
    pending.get('left').reject(new Error('upstream unavailable'));
    assert.equal((await first).ok, false);
    assert.equal(items[1].runStatus, R.STATUS.ERROR);
    assert.equal(items[2].runStatus, R.STATUS.RUNNING);
    assert.equal(source.runStatus, undefined);
    pending.get('right').resolve({ video: 'right.mp4' });
    assert.equal((await second).ok, true);
});

test('runFrom: a text AI config override still locks the shared generating node', async t => {
    const originalText = NT.text;
    let release;
    NT.text = { ...originalText, execute: () => new Promise(resolve => { release = resolve; }) };
    t.after(() => { NT.text = originalText; });
    const items = [op('source', 'text'), op('left', 'video'), op('right', 'video')];
    const ctx = makeCtx(items, [conn('source', 'text', 'left', 'source'), conn('source', 'text', 'right', 'source')]);
    ctx.cancelGenerationTasks = id => { if (id === 'source') release({ text: 'late' }); };
    const runner = new R.GraphRunner(ctx);
    const first = runner.runFrom('left', { configOverrides: new Map([['source', { useAi: true }]]) });
    assert.equal(runner.activeNodes.has('source'), true);
    assert.equal((await runner.runFrom('right')).ok, false);
    await runner.cancel('left');
    assert.equal((await first).canceled, true);
});

test('runFrom: editing a queued shared input cannot turn a read into an unconfirmed AI call', async t => {
    let release;
    NT.__test_gate = { inputs: [], outputs: [{ name: 'out', dataType: 'string' }],
        execute: () => new Promise(resolve => { release = resolve; }) };
    t.after(() => { delete NT.__test_gate; });
    const source = op('source', 'text', { text: 'original' });
    const target = op('target', 'text');
    const runner = new R.GraphRunner(makeCtx([op('gate', '__test_gate'), source, target], [
        conn('gate', 'out', 'target', 'context'), conn('source', 'text', 'target', 'context')
    ]));
    const pending = runner.runFrom('target');
    source.config.useAi = true;
    source.config.text = 'edited';
    release({ out: 'ready' });
    assert.equal((await pending).ok, true);
    assert.equal(runner.getResult('target').text, 'ready\noriginal');
    assert.deepEqual(source.config, { useAi: true, text: 'edited' });
});

test('runFrom: 环形脏数据被拒绝执行', async () => {
    const items = [op('a', 'text'), op('b', 'text')];
    const edges = [
        conn('a', 'merged', 'b', 'text_a'),
        conn('b', 'merged', 'a', 'text_a')
    ];
    const res = await new R.GraphRunner(makeCtx(items, edges)).runFrom('a');
    assert.equal(res.ok, false);
    assert.match(res.reason, /环形依赖/);
});

test('config 缺省值由节点类型的 default 补齐', async () => {
    // text 的 separator 默认 '\n'，config 留空时应生效
    const items = [
        op('a', 'text', { text: 'x' }),
        op('b', 'text', { text: 'y' }),
        op('m', 'text', {})
    ];
    const edges = [conn('a', 'text', 'm', 'context'), conn('b', 'text', 'm', 'context')];
    const runner = new R.GraphRunner(makeCtx(items, edges));
    await runner.runFrom('m');
    assert.equal(runner.getResult('m').text, 'x\ny');
});

test('runFrom: 已有生成产物作为上游时直接复用，不重复调用生成模型', async () => {
    NT.__test_image_sink = {
        type: '__test_image_sink', title: '图片接收', icon: 'image', color: '#0f0', width: 100,
        inputs: [{ name: 'image', dataType: 'image' }],
        outputs: [{ name: 'out', dataType: 'image' }],
        config: [],
        async execute(inputs) { return { out: inputs.image }; }
    };
    const source = {
        ...op('generated', 'image', { prompt: '不应再次执行' }),
        resultEntries: [{ filePath: 'C:/outputs/generated.png', url: '', item: null }]
    };
    const sink = op('sink', '__test_image_sink');
    const edges = [conn('generated', 'image', 'sink', 'image')];
    const runner = new R.GraphRunner(makeCtx([source, sink], edges));

    const result = await runner.runFrom('sink');

    assert.equal(result.ok, true);
    assert.equal(runner.getResult('generated').image,
        'local-res://' + encodeURIComponent('C:/outputs/generated.png'));
    assert.equal(runner.getResult('sink').out,
        'local-res://' + encodeURIComponent('C:/outputs/generated.png'));
    delete NT.__test_image_sink;
});

test('runFrom: 单次配置覆盖不会改写节点持久化配置', async () => {
    NT.__test_config_override = {
        type: '__test_config_override', title: '配置覆盖', icon: 'settings', color: '#00f', width: 100,
        inputs: [], outputs: [{ name: 'out', dataType: 'string' }], config: [],
        async execute(_inputs, config) { return { out: config.prompt }; }
    };
    const item = op('target', '__test_config_override', { prompt: '原提示词' });
    const runner = new R.GraphRunner(makeCtx([item]));

    const result = await runner.runFrom('target', {
        configOverrides: { target: { prompt: '本次 Agent 提示词' } }
    });

    assert.equal(result.ok, true);
    assert.equal(runner.getResult('target').out, '本次 Agent 提示词');
    assert.equal(item.config.prompt, '原提示词');
    delete NT.__test_config_override;
});

test('resetAll: 把非 idle 状态清回 idle 并清空缓存', async () => {
    const items = [op('t1', 'text', { text: 'x' })];
    const ctx = makeCtx(items);
    const runner = new R.GraphRunner(ctx);
    await runner.runFrom('t1');
    assert.equal(runner.getResult('t1').text, 'x');

    runner.resetAll();
    assert.equal(items[0].runStatus, R.STATUS.IDLE);
    assert.equal(runner.getResult('t1'), null);
});

test('每次运行重建缓存，配置改动后能拿到新结果', async () => {
    const items = [op('t1', 'text', { text: 'first' })];
    const runner = new R.GraphRunner(makeCtx(items));

    await runner.runFrom('t1');
    assert.equal(runner.getResult('t1').text, 'first');

    items[0].config.text = 'second';
    await runner.runFrom('t1');
    assert.equal(runner.getResult('t1').text, 'second');
});

test('runFrom: 接受 Map 形式的 items', async () => {
    const item = op('t1', 'text', { text: 'z' });
    const map = new Map([['t1', item]]);
    const runner = new R.GraphRunner({
        getItems: () => map,
        getConnections: () => [],
        onStatus: () => {}
    });
    assert.equal((await runner.runFrom('t1')).ok, true);
    assert.equal(runner.getResult('t1').text, 'z');
});

test('runFrom: 批量生成结果逐个触发落地', async () => {
    NT.__test_batch_output = {
        type: '__test_batch_output', title: '批量结果', icon: 'layers', color: '#00f', width: 100,
        inputs: [], outputs: [{ name: 'image', dataType: 'image' }], config: [],
        async execute() {
            const outputs = [{ image: 'one.png' }, { image: 'two.png' }];
            return { image: outputs.map(item => item.image), _batchResults: outputs };
        }
    };
    const items = [op('batch-result', '__test_batch_output')];
    const landed = [];
    const ctx = makeCtx(items);
    ctx.onResult = (_item, output) => landed.push(output.image);

    const result = await new R.GraphRunner(ctx).runFrom('batch-result');
    assert.equal(result.ok, true);
    assert.deepEqual(landed, ['one.png', 'two.png']);
    delete NT.__test_batch_output;
});

test('two media references reach image submission in connection order with matching prompt labels', async () => {
    const previousWindow = globalThis.window;
    let submitted;
    globalThis.window = { flowCanvas: { mcp: { generateImage: async body => {
        submitted = body;
        return { success: true, filePaths: ['result.png'] };
    } } } };
    try {
        const items = [media('a', '/fixtures/person.png'), media('b', '/fixtures/ship.png'), op('g', 'image', {
            prompt: '以的背景放入的人物',
            referenceCitationIds: ['a->g', 'b->g'], referenceCitationLabels: ['图一', '图二'],
            referenceCitationOccurrences: [
                { id: 'one', connectionId: 'b->g', offset: 1 },
                { id: 'two', connectionId: 'a->g', offset: 6 }
            ]
        })];
        const ctx = makeCtx(items, [conn('a', 'out', 'g', 'source'), conn('b', 'out', 'g', 'source')]);
        ctx.getImageProvider = () => ({ apiKey: 'fixture', model: 'gpt-image-2.5-sunburst' });
        ctx.prepareImageReferences = async references => references.map(reference => ({ filePath: reference.filePath.replace('.png', '-small.png') }));
        const result = await new R.GraphRunner(ctx).runFrom('g');
        assert.equal(result.ok, true, result.reason);
        assert.deepEqual(submitted.sourceReferences.map(reference => reference.filePath), ['/fixtures/person-small.png', '/fixtures/ship-small.png']);
        assert.match(submitted.prompt, /图一=第1张，图二=第2张/);
        assert.match(submitted.prompt, /以图二的背景放入图一的人物/);
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});

test('cancel: clicking an upstream node cancels its whole pending chain, not an independent run', async t => {
    const releases = new Map();
    NT.__audit_slow = { title: 'Slow', inputs: [], outputs: [{ name: 'out', dataType: 'string' }],
        execute: (_input, _config, ctx) => new Promise(resolve => releases.set(ctx.item.id, resolve)) };
    t.after(() => delete NT.__audit_slow);
    const items = [op('upstream', '__audit_slow'), op('target', 'text'), op('independent', '__audit_slow')];
    const canceled = [];
    const ctx = makeCtx(items, [conn('upstream', 'out', 'target', 'context')]);
    ctx.cancelGenerationTasks = async id => { canceled.push(id); releases.get(id)?.({ out: 'late' }); };
    const runner = new R.GraphRunner(ctx);
    const chain = runner.runFrom('target');
    const independent = runner.runFrom('independent');
    assert.equal(await runner.cancel('upstream'), true);
    assert.deepEqual(canceled.sort(), ['target', 'upstream']);
    assert.equal((await chain).canceled, true);
    assert.equal(items[0].runStatus, 'canceled');
    assert.equal(items[1].runStatus, 'canceled');
    assert.equal(items[2].runStatus, 'running');
    releases.get('independent')({ out: 'ok' });
    assert.equal((await independent).ok, true);
});

test('failure ends queued sibling animations instead of leaving them running forever', async t => {
    NT.__audit_fail = { title: 'Fail', inputs: [], outputs: [{ name: 'out', dataType: 'string' }],
        execute: async () => { throw new Error('provider failed'); } };
    t.after(() => delete NT.__audit_fail);
    const items = [op('fail', '__audit_fail'), op('queued', 'text', { useAi: true }), op('target', 'text')];
    const ctx = makeCtx(items, [conn('fail', 'out', 'target', 'context'), conn('queued', 'text', 'target', 'context')]);
    const result = await new R.GraphRunner(ctx).runFrom('target');
    assert.equal(result.ok, false);
    assert.equal(items[1].runStatus, 'canceled');
    assert.ok(items.every(item => !['queued', 'running'].includes(item.runStatus)));
});

test('canvas persistence failure is reported and cached outputs are retained for recovery', async () => {
    const item = op('text', 'text', { text: 'saved response' });
    const ctx = makeCtx([item]);
    ctx.onResult = async () => { throw new Error('disk unavailable'); };
    const runner = new R.GraphRunner(ctx);
    const result = await runner.runFrom(item.id);
    assert.equal(result.ok, false);
    assert.match(result.reason, /画布保存失败/);
    assert.equal(item.runStatus, 'error');
    assert.deepEqual(runner.getResult(item.id), { text: 'saved response' });
});

test('timer start is stable during status changes and renewed for a new run', () => {
    const item = op('video', 'video');
    const runner = new R.GraphRunner(makeCtx([item]));
    runner._setStatus(item, R.STATUS.QUEUED);
    item.runStartedAt -= 10000;
    const original = item.runStartedAt;
    runner._setStatus(item, R.STATUS.RUNNING);
    assert.equal(item.runStartedAt, original);
    runner._setStatus(item, R.STATUS.DONE);
    assert.equal(item.runStartedAt, original);
    runner._setStatus(item, R.STATUS.QUEUED);
    assert.ok(item.runStartedAt > original);
});

for (const kind of ['image', 'video']) {
    test(`${kind} captures project, output folder and source node before switching projects during reference preparation`, async t => {
        const preparing = deferred();
        const prepared = deferred();
        let activeProjectId = 'a';
        let captures = 0;
        const boards = new Map(['a', 'b'].map(id => [id, [
            media('reference', `C:/${id}/reference.png`), op('shared-node', kind, { prompt: `Render ${id}` })
        ]]));
        const originalNode = structuredClone(boards.get('a')[1]);
        const originalOtherBoard = structuredClone(boards.get('b'));
        const tasks = [];
        const submissions = [];
        const landed = [];
        const outputPath = `C:/a/output.${kind === 'image' ? 'png' : 'mp4'}`;
        mockGenerationBridge(t, { [kind === 'image' ? 'generateImage' : 'generateVideo']: async body => {
            submissions.push(structuredClone(body));
            return { success: true, filePath: outputPath };
        } });
        const context = { projectId: 'a', targetDir: 'C:/a/output' };
        const runner = new R.GraphRunner({
            captureRunContext: () => { captures++; return { projectId: activeProjectId, targetDir: `C:/${activeProjectId}/output` }; },
            getItems: () => boards.get(activeProjectId),
            getConnections: () => [conn('reference', 'out', 'shared-node', 'source')],
            beforeRun: captured => { assert.deepEqual(captured, context); return true; },
            getImageProvider: () => ({ apiKey: 'fixture', model: 'gpt-image-2.5-sunburst' }),
            getVideoProvider: () => ({ apiKey: 'fixture', model: 'sora-2' }),
            getImageIntentPipelineMode: () => 'off',
            prepareImageReferences: references => {
                preparing.resolve(structuredClone(references));
                return prepared.promise;
            },
            createGenerationTask: details => {
                tasks.push(structuredClone(details));
                return { id: 'task-a', projectId: details.projectId,
                    params: { ...details.params, targetDir: details.targetDir } };
            },
            onResult: async (item, output, captured) => {
                assert.equal(item, boards.get('a')[1]);
                assert.deepEqual(captured.expectedNode, originalNode);
                landed.push({ projectId: captured.projectId, targetDir: captured.targetDir, output });
                item.resultEntries = [{ filePath: output._resultFilePath }];
            }
        });

        const pending = runner.runFrom('shared-node');
        const references = await preparing.promise;
        assert.deepEqual(references.map(reference => reference.filePath), ['C:/a/reference.png']);
        assert.equal(submissions.length, 0);
        activeProjectId = 'b';
        prepared.resolve([{ filePath: 'C:/a/reference-prepared.png' }]);
        const result = await pending;
        assert.equal(result.ok, true, result.reason);
        assert.equal(captures, 1, 'Execution must not recapture the active project after an await');
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0].projectId, 'a');
        assert.equal(tasks[0].targetDir, 'C:/a/output');
        assert.equal(submissions.length, 1);
        assert.equal(submissions[0].projectId, 'a');
        assert.equal(submissions[0].nodeId, 'shared-node');
        assert.equal(submissions[0].targetDir, 'C:/a/output');
        assert.deepEqual(submissions[0].sourceReferences.map(reference => reference.filePath), ['C:/a/reference-prepared.png']);
        assert.equal(landed.length, 1);
        assert.equal(landed[0].projectId, 'a');
        assert.equal(landed[0].targetDir, 'C:/a/output');
        assert.equal(landed[0].output._resultFilePath, outputPath);
        assert.deepEqual(boards.get('a')[1].resultEntries, [{ filePath: outputPath }]);
        assert.deepEqual(boards.get('b'), originalOtherBoard);
        assert.equal(runner.getResult('shared-node'), null);
        activeProjectId = 'a';
        assert.equal(runner.getResult('shared-node')._resultFilePath, outputPath);
        assert.equal(runner.activeNodes.size, 0);
        assert.equal(runner.activeRuns.size, 0);
    });
}

for (const cancelSecond of [false, true]) {
    test(`same node IDs in different projects isolate concurrent locks, results and ${cancelSecond ? 'cancellation' : 'completion'}`, async t => {
        let activeProjectId = 'a';
        const boards = new Map(['a', 'b'].map(id => [id, [op('same-id', 'image', { prompt: `Render ${id}` })]]));
        const pendingApi = new Map();
        const submissions = [];
        const landed = [];
        const cancellations = [];
        mockGenerationBridge(t, { generateImage: body => {
            submissions.push(structuredClone(body));
            const request = deferred();
            pendingApi.set(body.projectId, request);
            return request.promise;
        } });
        const runner = new R.GraphRunner({
            captureRunContext: () => ({ projectId: activeProjectId, targetDir: `C:/${activeProjectId}` }),
            getItems: () => boards.get(activeProjectId), getConnections: () => [],
            getImageProvider: () => ({ apiKey: 'fixture', model: 'gpt-image-2.5-sunburst' }),
            getImageIntentPipelineMode: () => 'off',
            createGenerationTask: details => ({ id: `task-${details.projectId}`, projectId: details.projectId,
                params: { ...details.params, targetDir: details.targetDir } }),
            onResult: (item, output, context) => {
                assert.equal(item, boards.get(context.projectId)[0]);
                landed.push({ projectId: context.projectId, filePath: output._resultFilePath });
            },
            cancelGenerationTasks: (nodeId, context) => {
                cancellations.push({ nodeId, ...context });
                pendingApi.get(context.projectId).resolve({ success: true, filePath: `C:/${context.projectId}/late.png` });
            }
        });
        const first = runner.runFrom('same-id');
        assert.equal((await runner.runFrom('same-id')).ok, false);
        activeProjectId = 'b';
        const second = runner.runFrom('same-id');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(submissions.map(body => body.projectId), ['a', 'b']);
        assert.deepEqual(submissions.map(body => body.clientTaskId), ['task-a', 'task-b']);
        assert.equal(runner.activeRuns.size, 2);
        assert.equal((await runner.runFrom('same-id')).ok, false);
        assert.equal(submissions.length, 2, 'A duplicate in either project must not submit');

        if (cancelSecond) {
            assert.equal(await runner.cancel('same-id'), true);
            assert.equal((await second).canceled, true);
            assert.deepEqual(cancellations, [{ nodeId: 'same-id', projectId: 'b', targetDir: 'C:/b' }]);
            assert.equal(boards.get('b')[0].runStatus, R.STATUS.CANCELED);
            assert.equal(runner.getResult('same-id'), null);
        } else {
            pendingApi.get('b').resolve({ success: true, filePath: 'C:/b/output.png' });
            assert.equal((await second).ok, true);
            assert.equal(boards.get('b')[0].runStatus, R.STATUS.DONE);
            assert.equal(runner.getResult('same-id')._resultFilePath, 'C:/b/output.png');
        }
        assert.equal(await runner.cancel('same-id'), false, 'An inactive B run must not cancel the same node in A');
        assert.equal(boards.get('a')[0].runStatus, R.STATUS.RUNNING);
        assert.equal(runner.activeRuns.size, 1);
        pendingApi.get('a').resolve({ success: true, filePath: 'C:/a/output.png' });
        assert.equal((await first).ok, true);
        activeProjectId = 'a';
        assert.equal(runner.getResult('same-id')._resultFilePath, 'C:/a/output.png');
        activeProjectId = 'b';
        assert.equal(runner.getResult('same-id')?._resultFilePath || null, cancelSecond ? null : 'C:/b/output.png');
        assert.deepEqual(landed, [
            ...(cancelSecond ? [] : [{ projectId: 'b', filePath: 'C:/b/output.png' }]),
            { projectId: 'a', filePath: 'C:/a/output.png' }
        ]);
        assert.equal(runner.activeRuns.size, 0);
        assert.equal(runner.activeNodes.size, 0);
    });
}

for (const kind of ['image', 'video']) {
    test(`${kind} partialOutput lands every successful in-flight result and caches it before reporting batch failure`, async t => {
        const requests = [];
        const tasks = [];
        const taskUpdates = [];
        const errors = [];
        const landed = [];
        const landingStarted = deferred();
        const finishLanding = deferred();
        const target = op('generator', kind, { prompt: 'Render batch', count: 3, concurrency: 3 });
        const downstream = op('downstream', 'text');
        const items = [target, downstream];
        mockGenerationBridge(t, { [kind === 'image' ? 'generateImage' : 'generateVideo']: body => {
            const request = { ...deferred(), body };
            requests.push(request);
            return request.promise;
        } });
        const runner = new R.GraphRunner({
            ...makeCtx(items, [conn('generator', kind, 'downstream', 'context')]),
            captureRunContext: () => ({ projectId: 'a', targetDir: 'C:/a' }),
            getImageProvider: () => ({ apiKey: 'fixture', model: 'gpt-image-2.5-sunburst' }),
            getVideoProvider: () => ({ apiKey: 'fixture', model: 'sora-2' }),
            getImageIntentPipelineMode: () => 'off',
            createGenerationTask: details => {
                const task = { id: `task-${tasks.length}`, projectId: details.projectId,
                    params: { ...details.params, targetDir: details.targetDir } };
                tasks.push(task);
                return task;
            },
            updateGenerationTask: (id, patch) => taskUpdates.push({ id, patch }),
            recordGenerationError: (id, error) => errors.push({ id, error }),
            onResult: async (item, output, context) => {
                assert.equal(item, target);
                assert.equal(context.projectId, 'a');
                assert.equal(context.targetDir, 'C:/a');
                assert.deepEqual(context.expectedNode.resultEntries || [], item.resultEntries || []);
                if (!landed.length) {
                    landingStarted.resolve();
                    await finishLanding.promise;
                }
                item.resultEntries = [...(item.resultEntries || []), { filePath: output._resultFilePath }];
                landed.push(output);
            }
        });
        let settled = false;
        const pending = runner.runFrom('downstream').then(result => { settled = true; return result; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(requests.length, 3);
        const failure = new Error('Second request rejected');
        const extension = kind === 'image' ? 'png' : 'mp4';
        const paths = [`C:/a/first.${extension}`, `C:/a/third.${extension}`];
        requests[1].reject(failure);
        requests[2].resolve({ success: true, filePath: paths[1] });
        requests[0].resolve({ success: true, filePath: paths[0] });
        await landingStarted.promise;
        assert.equal(settled, false, 'The failed run still waits for successful output persistence');
        assert.deepEqual(runner.getResult('generator')._batchResults.map(output => output._resultFilePath), paths);
        finishLanding.resolve();
        const result = await pending;
        assert.equal(result.ok, false);
        assert.equal(result.reason, failure.message);
        assert.equal(result.failedAt, 'generator');
        assert.equal(target.runStatus, R.STATUS.ERROR);
        assert.equal(downstream.runStatus, R.STATUS.ERROR);
        assert.deepEqual(target.resultEntries, paths.map(filePath => ({ filePath })));
        assert.deepEqual(landed.map(output => output._resultFilePath), paths);
        assert.deepEqual(runner.getResult('generator')._batchResults, landed);
        assert.equal(runner.getResult('downstream'), null, 'A failed batch must not execute its downstream node');
        assert.deepEqual(errors, [{ id: 'task-1', error: failure }]);
        assert.deepEqual(taskUpdates.filter(update => update.patch.status === 'success').map(update => update.id).sort(), ['task-0', 'task-2']);
        assert.equal(requests.length, 3, 'Partial failure must not automatically resubmit');
        assert.equal(runner.activeRuns.size, 0);
        assert.equal(runner.activeNodes.size, 0);
    });
}
