const test = require('node:test');
const assert = require('node:assert/strict');

let B;
test.before(async () => {
    B = await import('./board-transaction.js');
});

function media(id, filePath, x = 0, y = 0) {
    return { id, kind: 'media', mediaType: 'image', filePath, x, y, width: 200, height: 120 };
}

function op(id, nodeType, config = {}, x = 0, y = 0) {
    return { id, kind: 'op', nodeType, config, x, y, width: 320, height: 220 };
}

function snapshot(overrides = {}) {
    return B.createBoardSnapshot({
        projectId: 'project-a',
        revision: 4,
        items: [media('image-1', 'C:/one.png'), op('text-1', 'text', { text: 'hello' })],
        connections: [],
        plans: [],
        viewport: { x: 0, y: 0, scale: 1 },
        ...overrides
    });
}

test('snapshot scopes selection and neighborhood without mutating source', () => {
    const source = {
        projectId: 'p',
        revision: 2,
        items: [op('a', 'text'), op('b', 'image'), op('c', 'video')],
        connections: [
            { id: 'ab', from: { nodeId: 'a', port: 'text' }, to: { nodeId: 'b', port: 'source' } },
            { id: 'bc', from: { nodeId: 'b', port: 'image' }, to: { nodeId: 'c', port: 'source' } }
        ]
    };
    const selected = B.createBoardSnapshot(source, { scope: 'selection', selectedItemIds: ['b'] });
    const neighborhood = B.createBoardSnapshot(source, { scope: 'neighborhood', selectedItemIds: ['b'], depth: 1 });

    assert.deepEqual(selected.items.map(item => item.id), ['b']);
    assert.equal(selected.connections.length, 0);
    assert.deepEqual(neighborhood.items.map(item => item.id), ['a', 'b', 'c']);
    neighborhood.items[0].x = 999;
    assert.equal(source.items[0].x, 0);
});

test('viewport snapshot includes every node when bounds are omitted', () => {
    const current = B.createBoardSnapshot({
        projectId: 'p',
        items: [op('left', 'text', {}, -1000, -500), op('right', 'text', {}, 1200, 900)]
    }, { scope: 'viewport' });
    assert.deepEqual(current.items.map(item => item.id), ['left', 'right']);
});

test('preview resolves temporary ids and leaves the input snapshot untouched', () => {
    const current = snapshot();
    const transaction = {
        id: 'tx-create-and-connect',
        baseRevision: 4,
        operations: [
            { op: 'node.create', tempId: 'generated', nodeType: 'image', position: { x: 500, y: 100 } },
            {
                op: 'connection.create',
                from: { nodeId: 'text-1', port: 'text' },
                to: { nodeId: 'generated', port: 'source' }
            }
        ]
    };

    const preview = B.previewBoardTransaction(current, transaction);
    assert.equal(preview.ok, true);
    assert.equal(preview.nextRevision, 5);
    assert.match(preview.tempIds.generated, /^node_/);
    assert.equal(preview.summary.nodesCreated, 1);
    assert.equal(preview.summary.connectionsCreated, 1);
    assert.equal(current.items.length, 2);
    assert.equal(current.connections.length, 0);
});

test('apply is atomic and supports idempotent retries', () => {
    const current = snapshot();
    const transaction = {
        id: 'tx-atomic',
        baseRevision: 4,
        idempotencyKey: 'atomic-key',
        operations: [
            { op: 'node.update', nodeId: 'text-1', patch: { title: 'Prompt' } },
            { op: 'layout.arrange', nodeIds: ['text-1', 'image-1'], mode: 'horizontal', gap: 40 }
        ]
    };
    const applied = B.applyBoardTransaction(current, transaction);
    assert.equal(applied.snapshot.revision, 5);
    assert.equal(applied.snapshot.items.find(item => item.id === 'text-1').title, 'Prompt');
    assert.deepEqual(applied.snapshot.appliedTransactionKeys, ['atomic-key']);
    assert.ok(applied.undoToken);
    assert.equal(current.items.find(item => item.id === 'text-1').title, undefined);

    const retry = B.applyBoardTransaction(applied.snapshot, { ...transaction, baseRevision: 5 });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.snapshot.revision, 5);
});

test('failed operation rejects the whole transaction', () => {
    const current = snapshot();
    assert.throws(() => B.applyBoardTransaction(current, {
        id: 'tx-fail',
        baseRevision: 4,
        operations: [
            { op: 'node.update', nodeId: 'text-1', patch: { title: 'changed' } },
            { op: 'node.delete', nodeId: 'missing' }
        ]
    }), error => error.code === 'NODE_NOT_FOUND' && error.details.operationIndex === 1);
    assert.equal(current.items.find(item => item.id === 'text-1').title, undefined);
});

test('revision and project conflicts are rejected before simulation', () => {
    const current = snapshot();
    const operation = [{ op: 'node.delete', nodeId: 'image-1' }];
    assert.throws(() => B.previewBoardTransaction(current, {
        id: 'stale', baseRevision: 3, operations: operation
    }), error => error.code === 'REVISION_CONFLICT');
    assert.throws(() => B.previewBoardTransaction(current, {
        id: 'wrong-project', projectId: 'project-b', baseRevision: 4, operations: operation
    }), error => error.code === 'PROJECT_MISMATCH');
});

test('connection validation catches incompatible types and cycles', () => {
    const current = snapshot({
        items: [op('text', 'text'), op('image', 'image'), op('video', 'video')],
        connections: [
            { id: 'text-image', from: { nodeId: 'text', port: 'text' }, to: { nodeId: 'image', port: 'source' } },
            { id: 'image-video', from: { nodeId: 'image', port: 'image' }, to: { nodeId: 'video', port: 'source' } }
        ]
    });
    assert.throws(() => B.previewBoardTransaction(current, {
        id: 'cycle', baseRevision: 4, operations: [{
            op: 'connection.create',
            from: { nodeId: 'video', port: 'video' },
            to: { nodeId: 'text', port: 'context' }
        }]
    }), error => error.code === 'INVALID_CONNECTION' && /环形/.test(error.message));
});

test('node deletion also removes graph edges and plan references', () => {
    const current = snapshot({
        connections: [{
            id: 'edge',
            from: { nodeId: 'image-1', port: 'out' },
            to: { nodeId: 'text-1', port: 'context' }
        }],
        plans: [{ rows: [{ references: [{ itemId: 'image-1', filePath: 'C:/one.png' }] }] }]
    });
    const applied = B.applyBoardTransaction(current, {
        id: 'delete', baseRevision: 4, operations: [{ op: 'node.delete', nodeId: 'image-1' }]
    });
    assert.equal(applied.snapshot.items.some(item => item.id === 'image-1'), false);
    assert.equal(applied.snapshot.connections.length, 0);
    assert.deepEqual(applied.snapshot.plans[0].rows[0].references, []);
});

test('grid layout keeps columns aligned when node sizes differ', () => {
    const current = snapshot({
        items: [
            { ...op('a', 'text'), width: 100, height: 100 },
            { ...op('b', 'text'), width: 300, height: 200 },
            { ...op('c', 'text'), width: 200, height: 120 },
            { ...op('d', 'text'), width: 150, height: 140 }
        ]
    });
    const applied = B.applyBoardTransaction(current, {
        id: 'grid', baseRevision: 4, operations: [{
            op: 'layout.arrange', nodeIds: ['a', 'b', 'c', 'd'], mode: 'grid', columns: 2, gap: 20,
            origin: { x: 50, y: 60 }
        }]
    });
    const byId = new Map(applied.snapshot.items.map(item => [item.id, item]));
    assert.deepEqual([byId.get('a').x, byId.get('a').y], [50, 60]);
    assert.deepEqual([byId.get('b').x, byId.get('b').y], [270, 60]);
    assert.deepEqual([byId.get('c').x, byId.get('c').y], [50, 280]);
    assert.deepEqual([byId.get('d').x, byId.get('d').y], [270, 280]);
});

test('history connections preserve provenance without executable-cycle rejection', () => {
    const current = snapshot({
        items: [op('source', 'image'), media('result', 'C:/result.png')],
        connections: [{
            id: 'downstream',
            from: { nodeId: 'result', port: 'out' },
            to: { nodeId: 'source', port: 'source' }
        }]
    });
    const applied = B.applyBoardTransaction(current, {
        id: 'history', baseRevision: 4, operations: [{
            op: 'connection.create', kind: 'history',
            from: { nodeId: 'source', port: 'image' },
            to: { nodeId: 'result', port: 'source' }
        }]
    });
    assert.equal(applied.snapshot.connections.at(-1).kind, 'history');
});

test('undo token restores content but keeps revision monotonic', () => {
    const current = snapshot();
    const applied = B.applyBoardTransaction(current, {
        id: 'delete-for-undo', baseRevision: 4, operations: [{ op: 'node.delete', nodeId: 'image-1' }]
    });
    const undone = B.undoBoardTransaction(applied.snapshot, applied.undoRecord);
    assert.equal(undone.snapshot.items.some(item => item.id === 'image-1'), true);
    assert.equal(undone.snapshot.revision, 6);
    assert.deepEqual(undone.snapshot.appliedTransactionKeys, ['delete-for-undo']);
});
