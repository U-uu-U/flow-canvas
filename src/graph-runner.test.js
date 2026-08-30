const test = require('node:test');
const assert = require('node:assert/strict');

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
    assert.equal(items.every(i => i.runStatus === R.STATUS.DONE), true);
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

test('runFrom: 共享上游的两条链不能同时执行', async () => {
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
