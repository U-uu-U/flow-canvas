const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate, stripRuntime, SCHEMA_VERSION } = require('./store');

test('migrate: v1 数据补 kind=media 和 connections', () => {
    const v1 = {
        version: 1,
        items: [
            { id: 'a', filePath: 'C:/a.png', x: 10, y: 20 },
            { id: 'b', filePath: 'C:/b.mp4', x: 30, y: 40 }
        ],
        folderGroups: []
    };

    const out = migrate(v1);
    assert.equal(out.version, SCHEMA_VERSION);
    assert.deepEqual(out.items.map(i => i.kind), ['media', 'media']);
    assert.deepEqual(out.connections, []);
    // 原有字段不丢
    assert.equal(out.items[0].filePath, 'C:/a.png');
    assert.equal(out.items[0].x, 10);
});

test('migrate: 没有 version 字段的远古数据视为 v1', () => {
    const out = migrate({ items: [{ id: 'a', filePath: 'x.png' }] });
    assert.equal(out.version, SCHEMA_VERSION);
    assert.equal(out.items[0].kind, 'media');
});

test('migrate: 文件夹组内的 savedItems 一并迁移', () => {
    const out = migrate({
        version: 1,
        items: [],
        folderGroups: [
            { id: 'g1', name: '组1', folders: [], savedItems: [{ id: 'x', filePath: 'p.png' }] },
            { id: 'g2', name: '组2', folders: [] }
        ]
    });

    assert.equal(out.folderGroups[0].savedItems[0].kind, 'media');
    assert.deepEqual(out.folderGroups[0].savedConnections, []);
    assert.deepEqual(out.folderGroups[1].savedItems, []);
    assert.equal(out.folderGroups[0].name, '组1');
});

test('migrate: 已是 v2 的数据原样返回，不覆盖 op 节点', () => {
    const v2 = {
        version: 2,
        items: [{ id: 'o', kind: 'op', nodeType: 'text_input', config: { text: 'hi' } }],
        connections: [{ id: 'e1', from: { nodeId: 'o', port: 'text' }, to: { nodeId: 'g', port: 'prompt' } }],
        folderGroups: []
    };
    const out = migrate(v2);
    assert.equal(out.items[0].kind, 'op');
    assert.equal(out.items[0].config.text, 'hi');
    assert.equal(out.connections.length, 1);
});

test('migrate: 混合数据不把已有 kind 改掉', () => {
    const out = migrate({
        version: 1,
        items: [
            { id: 'a', filePath: 'x.png' },
            { id: 'b', kind: 'op', nodeType: 'text_input' }
        ]
    });
    assert.deepEqual(out.items.map(i => i.kind), ['media', 'op']);
});

test('stripRuntime: 移除运行态字段', () => {
    const clean = stripRuntime({
        id: 'a', kind: 'op', config: { text: 'x' },
        runStatus: 'running', runError: 'boom', runResult: { image: 'data:...' }
    });
    assert.deepEqual(clean, { id: 'a', kind: 'op', config: { text: 'x' } });
});

test('stripRuntime: 不改动原对象', () => {
    const original = { id: 'a', runStatus: 'done' };
    stripRuntime(original);
    assert.equal(original.runStatus, 'done');
});
