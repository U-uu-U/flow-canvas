import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBoardService } from './agent-board-service.mjs';

const clone = value => structuredClone(value);
const media = id => ({ id, kind: 'media', mediaType: 'image', filePath: `C:/assets/${id}.png`, x: 0, y: 0 });

function fixture() {
    const group = id => ({
        id, name: id.toUpperCase(), folders: [`C:/${id}`], defaultSaveFolder: `C:/${id}`,
        savedItems: [media(`${id}-1`)], connections: [], plans: [], boardRevision: 0,
        appliedTransactionKeys: [], savedViewport: { x: 0, y: 0, scale: 1 },
        removedFromBoardPaths: [], removedFromBoardPathsInitialized: true
    });
    const a = group('a');
    return {
        folderGroups: [a, group('b')], activeGroupId: 'a', items: clone(a.savedItems),
        connections: [], plans: [], boardRevision: 0, appliedTransactionKeys: [],
        viewport: clone(a.savedViewport), watchFolders: clone(a.folders),
        activeGroupDefaultSaveFolder: a.defaultSaveFolder,
        removedFromBoardPaths: [], removedFromBoardPathsInitialized: true,
        defaultSaveFolder: 'C:/global', sidebarClosed: false, preferences: { theme: 'light' }
    };
}

function harness(initial = fixture(), onChange) {
    let data = clone(initial);
    let writes = 0;
    let rejectSave = false;
    const store = {
        load: () => data,
        save: next => {
            if (rejectSave) return false;
            data = clone(next);
            writes++;
            return true;
        }
    };
    return {
        service: new AgentBoardService({ store, onChange }), store,
        get data() { return clone(data); }, get writes() { return writes; },
        rejectSave(value) { rejectSave = value; }
    };
}

function transaction(projectId = 'b', baseRevision = 0, id = 'tx-1') {
    return {
        id, projectId, baseRevision,
        operations: [{ op: 'node.create', id: `${id}-node`, nodeType: 'text', item: { config: { text: 'hello' } } }]
    };
}

function envelope(data) {
    return {
        data: clone(data),
        sourceRevisions: Object.fromEntries(data.folderGroups.map(group => [group.id, group.boardRevision])),
        sourceActiveGroupId: data.activeGroupId
    };
}

function switchTo(save, id) {
    const group = save.data.folderGroups.find(entry => entry.id === id);
    Object.assign(save.data, {
        activeGroupId: id, items: clone(group.savedItems), connections: clone(group.connections),
        boardRevision: group.boardRevision, appliedTransactionKeys: clone(group.appliedTransactionKeys),
        viewport: clone(group.savedViewport), watchFolders: clone(group.folders)
    });
}

test('background snapshot and metadata use savedItems, not the active board', async () => {
    const h = harness();
    const result = h.service.readProject('b');
    assert.equal(result.projectId, 'b');
    assert.deepEqual(result.items.map(item => item.id), ['b-1']);
    assert.equal(result.defaultSaveFolder, 'C:/b');
    assert.deepEqual(result.folders, ['C:/b']);
    assert.equal(result.sourceRevision, 0);
    result.items[0].x = 99;
    result.folders.push('C:/other');
    assert.equal(h.data.folderGroups[1].savedItems[0].x, 0);
    assert.equal(h.writes, 0);
});

test('active snapshot uses top-level items and options scope selection', async () => {
    const data = fixture();
    data.items.push(media('live'));
    const h = harness(data);
    const snapshot = await h.service.snapshot('a', { scope: 'selection', selectedItemIds: ['live'], capturedAt: 123 });
    assert.deepEqual(snapshot.items.map(item => item.id), ['live']);
    assert.equal(snapshot.capturedAt, 123);
    assert.equal(h.writes, 0);
});

test('preview reuses transaction simulation without saving or activating the target', async () => {
    const h = harness();
    const before = h.data;
    const preview = await h.service.preview('b', transaction());
    assert.equal(preview.summary.nodesCreated, 1);
    assert.equal(preview.nextRevision, 1);
    assert.deepEqual(h.data, before);
    assert.equal(h.writes, 0);
});

test('background apply leaves every unrelated group and top-level field intact', async () => {
    const h = harness();
    const before = h.data;
    const result = await h.service.apply('b', transaction());
    const expected = clone(before);
    expected.folderGroups[1] = h.data.folderGroups[1];
    assert.deepEqual(h.data, expected);
    assert.equal(result.snapshot.items.length, 2);
    assert.equal(h.data.folderGroups[1].boardRevision, 1);
    assert.equal(h.data.activeGroupId, 'a');
});

test('active apply mirrors items, connections, plans, keys and revision', async () => {
    const h = harness();
    const beforeB = h.data.folderGroups[1];
    await h.service.apply('a', transaction('a'));
    const data = h.data;
    assert.deepEqual(data.items, data.folderGroups[0].savedItems);
    for (const key of ['connections', 'plans', 'appliedTransactionKeys', 'boardRevision']) {
        assert.deepEqual(data[key], data.folderGroups[0][key]);
    }
    assert.deepEqual(data.folderGroups[1], beforeB);
    assert.equal(data.defaultSaveFolder, 'C:/global');
});

test('original transaction retries stay idempotent across later edits and service restart', async () => {
    const h = harness();
    const request = transaction();
    await h.service.apply('b', request);
    await h.service.apply('b', transaction('b', 1, 'tx-2'));
    const restarted = new AgentBoardService({ store: h.store });
    const result = await restarted.apply('b', request);
    assert.equal(result.duplicate, true);
    assert.equal(result.nextRevision, 2);
    assert.equal(result.undoToken, null);
    assert.equal((await restarted.preview('b', request)).duplicate, true);
    assert.equal(h.writes, 2);
    assert.equal((await restarted.snapshot('b')).items.length, 3);
});

test('idempotency never bypasses project target validation', async () => {
    const h = harness();
    await h.service.apply('b', transaction());
    await assert.rejects(h.service.apply('b', { ...transaction(), projectId: 'a' }), { code: 'PROJECT_MISMATCH' });
    assert.equal(h.writes, 1);
});

test('concurrent writes to different projects are serialized without losing either', async () => {
    const h = harness();
    await Promise.all([h.service.apply('a', transaction('a')), h.service.apply('b', transaction())]);
    assert.deepEqual(h.data.folderGroups.map(group => group.boardRevision), [1, 1]);
    assert.deepEqual(h.data.folderGroups.map(group => group.savedItems.length), [2, 2]);
});

test('competing same-revision writes reject one and the queue remains usable', async () => {
    const h = harness();
    const results = await Promise.allSettled([
        h.service.apply('b', transaction()), h.service.apply('b', transaction('b', 0, 'other'))
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].reason.code, 'REVISION_CONFLICT');
    await h.service.apply('b', transaction('b', 1, 'third'));
    assert.equal(h.data.folderGroups[1].boardRevision, 2);
});

test('async writes share the FIFO, synchronous reads see committed data, and arguments are captured', async () => {
    const h = harness();
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const update = h.service.updateProject('b', async draft => {
        await barrier;
        draft.items.push(media('generated'));
        return 'generated';
    });
    const request = transaction('b', 1);
    const apply = h.service.apply('b', request);
    request.operations[0].id = 'mutated-after-call';
    assert.equal(h.service.readProject('b').revision, 0);
    release();
    assert.equal((await update).value, 'generated');
    await apply;
    const result = h.service.readProject('b');
    assert.equal(result.sourceRevision, 2);
    assert.deepEqual(result.items.map(item => item.id), ['b-1', 'generated', 'tx-1-node']);
});

test('renderer switch followed by background apply preserves the selected project', async () => {
    const h = harness();
    const save = envelope(h.data);
    switchTo(save, 'b');
    const merged = h.service.mergeRendererSave(save);
    const apply = h.service.apply('a', transaction('a'));
    assert.equal((await merged).ok, true);
    await apply;
    assert.equal(h.data.activeGroupId, 'b');
    assert.deepEqual(h.data.items.map(item => item.id), ['b-1']);
    assert.equal(h.data.folderGroups[0].savedItems.length, 2);
});

test('stale renderer save cannot overwrite a background Agent change but preserves preferences and switch', async () => {
    const h = harness();
    const save = envelope(h.data);
    switchTo(save, 'b');
    save.data.sidebarClosed = true;
    save.data.preferences.theme = 'dark';
    await h.service.apply('b', transaction());
    const result = await h.service.mergeRendererSave(save);
    assert.equal(result.ok, false);
    assert.deepEqual(result.conflicts.map(conflict => conflict.projectId), ['b']);
    assert.equal(result.conflicts[0].actualRevision, 1);
    assert.equal(result.data.activeGroupId, 'b');
    assert.equal(result.data.items.length, 2);
    assert.equal(result.data.sidebarClosed, true);
    assert.equal(result.data.preferences.theme, 'dark');
    assert.equal(result.sourceRevisions.b, 1);
    assert.deepEqual(result.data, h.data);
});

test('colliding renderer local revision is not accepted as a source revision', async () => {
    const h = harness();
    const save = envelope(h.data);
    save.data.folderGroups[1].savedItems[0].x = 90;
    save.data.folderGroups[1].boardRevision = 1;
    await h.service.apply('b', transaction());
    const result = await h.service.mergeRendererSave(save);
    assert.equal(result.conflicts[0].code, 'REVISION_CONFLICT');
    assert.equal(h.data.folderGroups[1].savedItems[0].x, 0);
    assert.equal(h.data.folderGroups[1].savedItems.length, 2);
});

test('fresh manual edits advance the service revision and preserve transaction keys', async () => {
    const h = harness();
    await h.service.apply('a', transaction('a'));
    const save = envelope(h.data);
    save.data.items[0].x = 48;
    save.data.folderGroups[0].boardRevision = 999;
    save.data.folderGroups[0].appliedTransactionKeys = [];
    const result = await h.service.mergeRendererSave(save);
    assert.equal(result.ok, true);
    assert.equal(result.sourceRevisions.a, 2);
    assert.equal(result.data.items[0].x, 48);
    assert.deepEqual(result.data.appliedTransactionKeys, ['tx-1']);
});

test('canonical equal renderer content ignores object key order and stale revision without writing', async () => {
    const h = harness();
    await h.service.apply('b', transaction());
    const save = envelope(h.data);
    save.sourceRevisions.b = 0;
    const group = save.data.folderGroups[1];
    group.savedItems[0] = Object.fromEntries(Object.entries(group.savedItems[0]).reverse());
    group.boardRevision = 0;
    const result = await h.service.mergeRendererSave(save);
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(h.writes, 1);
    assert.equal(result.sourceRevisions.b, 1);
});

test('raw legacy saves allow preferences but reject changed boards without source revisions', async () => {
    const h = harness();
    const raw = h.data;
    raw.items[0].x = 75;
    raw.sidebarClosed = true;
    const result = await h.service.mergeRendererSave(raw);
    assert.equal(result.conflicts[0].code, 'SOURCE_REVISION_REQUIRED');
    assert.equal(result.data.items[0].x, 0);
    assert.equal(result.data.sidebarClosed, true);
});

test('conflict in one project does not discard a fresh edit in another project', async () => {
    const h = harness();
    const save = envelope(h.data);
    save.data.items[0].x = 40;
    await h.service.apply('b', transaction());
    const result = await h.service.mergeRendererSave(save);
    assert.equal(result.ok, false);
    assert.deepEqual(result.changedProjectIds, ['a']);
    assert.equal(result.data.items[0].x, 40);
    assert.equal(result.data.folderGroups[1].savedItems.length, 2);
});

test('an old renderer save cannot switch back after a newer switch', async () => {
    const h = harness();
    const stale = envelope(h.data);
    const switchSave = envelope(h.data);
    switchTo(switchSave, 'b');
    await h.service.mergeRendererSave(switchSave);
    const result = await h.service.mergeRendererSave(stale);
    assert.equal(result.conflicts[0].code, 'ACTIVE_GROUP_CONFLICT');
    assert.equal(result.data.activeGroupId, 'b');
    assert.deepEqual(result.data.items, result.data.folderGroups[1].savedItems);
});

test('project metadata writes are revisioned and stale renderer metadata cannot revert them', async () => {
    const h = harness();
    const stale = envelope(h.data);
    await h.service.updateProject('b', draft => {
        draft.folders.push('C:/new');
        draft.defaultSaveFolder = 'C:/new';
        draft.name = 'Renamed';
    });
    const result = await h.service.mergeRendererSave(stale);
    assert.equal(result.conflicts[0].projectId, 'b');
    assert.equal(h.service.readProject('b').defaultSaveFolder, 'C:/new');
    assert.equal(h.data.activeGroupId, 'a');
    assert.equal(h.data.defaultSaveFolder, 'C:/global');
});

test('undo restores board references but keeps idempotency and does not activate its target', async () => {
    const h = harness();
    const result = await h.service.apply('b', transaction());
    result.undoRecord.beforeSnapshot.items.length = 0;
    const undone = await h.service.undo('b', result.undoToken);
    assert.equal(undone.nextRevision, 2);
    assert.deepEqual(undone.snapshot.items.map(item => item.id), ['b-1']);
    assert.equal(h.data.activeGroupId, 'a');
    assert.equal((await h.service.apply('b', transaction())).duplicate, true);
    await assert.rejects(h.service.undo('b', result.undoToken), { code: 'INVALID_UNDO_TOKEN' });
});

test('undo cannot erase later runtime, renderer, or metadata edits', async () => {
    for (const mode of ['runtime', 'renderer', 'metadata']) {
        const h = harness();
        const result = await h.service.apply('b', transaction());
        if (mode === 'renderer') {
            const save = envelope(h.data);
            save.data.folderGroups[1].savedItems[0].x = 50;
            await h.service.mergeRendererSave(save);
        } else {
            await h.service.updateProject('b', draft => {
                if (mode === 'metadata') draft.name = 'Later';
                else draft.items[0].x = 50;
            });
        }
        const before = h.data;
        await assert.rejects(h.service.undo('b', result.undoToken), { code: 'REVISION_CONFLICT' });
        assert.deepEqual(h.data, before);
    }
});

test('undo tokens are project scoped and process local', async () => {
    const h = harness();
    const result = await h.service.apply('b', transaction());
    await assert.rejects(h.service.undo('a', result.undoToken), { code: 'INVALID_UNDO_TOKEN' });
    const restarted = new AgentBoardService({ store: h.store });
    await assert.rejects(restarted.undo('b', result.undoToken), { code: 'INVALID_UNDO_TOKEN' });
});

test('failed saves do not publish notifications or register a transaction and can be retried', async () => {
    const events = [];
    const h = harness(fixture(), event => events.push(event));
    const before = h.data;
    h.rejectSave(true);
    await assert.rejects(h.service.apply('b', transaction()), { code: 'SAVE_FAILED' });
    assert.deepEqual(h.data, before);
    assert.equal(events.length, 0);
    h.rejectSave(false);
    const result = await h.service.apply('b', transaction());
    assert.equal(result.duplicate, false);
    assert.equal(events.length, 1);
});

test('failed undo keeps its record for retry', async () => {
    const h = harness();
    const result = await h.service.apply('b', transaction());
    h.rejectSave(true);
    await assert.rejects(h.service.undo('b', result.undoToken), { code: 'SAVE_FAILED' });
    h.rejectSave(false);
    assert.equal((await h.service.undo('b', result.undoToken)).nextRevision, 2);
});

test('notification failures and mutation cannot corrupt a committed board', async () => {
    const h = harness(fixture(), async event => {
        event.data.folderGroups.length = 0;
        throw new Error('observer unavailable');
    });
    assert.equal((await h.service.apply('b', transaction())).ok, true);
    assert.equal(h.data.folderGroups.length, 2);
    assert.equal(h.writes, 1);
});

test('no-op and failed runtime callbacks leave data and revision untouched', async () => {
    const h = harness();
    assert.equal((await h.service.updateProject('b', () => 'result')).changed, false);
    await assert.rejects(h.service.updateProject('b', draft => {
        draft.items.length = 0;
        throw new Error('generation failed');
    }), /generation failed/);
    await assert.rejects(h.service.updateProject('b', draft => { draft.revision = 99; }), { code: 'INVALID_PROJECT_UPDATE' });
    await assert.rejects(h.service.updateProject('b', draft => { draft.id = 'a'; }), { code: 'INVALID_PROJECT_UPDATE' });
    assert.equal(h.writes, 0);
    assert.deepEqual(h.data, fixture());
});

test('new projects and deletion require explicit source intent, stale omission retains Agent work', async () => {
    const h = harness();
    const stale = envelope(h.data);
    stale.data.folderGroups = stale.data.folderGroups.filter(group => group.id !== 'b');
    await h.service.apply('b', transaction());
    const conflict = await h.service.mergeRendererSave(stale);
    assert.equal(conflict.ok, false);
    assert.equal(h.data.folderGroups.length, 2);
    const fresh = envelope(h.data);
    fresh.data.folderGroups = fresh.data.folderGroups.filter(group => group.id !== 'b');
    fresh.data.folderGroups.push({ ...clone(fresh.data.folderGroups[0]), id: 'c' });
    fresh.sourceRevisions.c = null;
    const result = await h.service.mergeRendererSave(fresh);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.folderGroups.map(group => group.id), ['a', 'c']);
    assert.equal(result.sourceRevisions.c, 0);
});

test('deleting the active project clears its mirrors rather than exposing removed content', async () => {
    const h = harness();
    const save = envelope(h.data);
    save.data.folderGroups = save.data.folderGroups.filter(group => group.id !== 'a');
    const result = await h.service.mergeRendererSave(save);
    assert.equal(result.ok, true);
    assert.equal(result.data.activeGroupId, null);
    assert.deepEqual(result.data.items, []);
    assert.deepEqual(result.data.watchFolders, []);
    assert.deepEqual(result.data.folderGroups[0].savedItems, [media('b-1')]);
});

test('invalid input and atomic transaction failures never partially save', async () => {
    const h = harness();
    assert.throws(() => h.service.snapshot('missing'), { code: 'PROJECT_NOT_FOUND' });
    const tx = transaction();
    tx.operations.push({ op: 'node.delete', nodeId: 'missing' });
    await assert.rejects(h.service.apply('b', tx), { code: 'NODE_NOT_FOUND' });
    assert.throws(() => h.service.mergeRendererSave({ items: [] }), { code: 'INVALID_RENDERER_SAVE' });
    const save = envelope(h.data);
    save.data.folderGroups.push(clone(save.data.folderGroups[0]));
    assert.throws(() => h.service.mergeRendererSave(save), { code: 'INVALID_RENDERER_SAVE' });
    assert.equal(h.writes, 0);
    assert.deepEqual(h.data, fixture());
});

test('preference-only saves preserve ungrouped legacy board data and active mirrors exactly', async () => {
    for (const initial of [fixture(), { ...fixture(), folderGroups: [], activeGroupId: null }]) {
        initial.items.push(media('unsynced'));
        const h = harness(initial);
        const result = await h.service.mergeRendererSave({ sidebarClosed: true });
        assert.equal(result.ok, true);
        assert.deepEqual(h.data, { ...initial, sidebarClosed: true });
    }
});

test('deleting and recreating a project cannot revive undo records from its previous lifetime', async () => {
    const h = harness();
    const old = await h.service.apply('b', transaction());
    const remove = envelope(h.data);
    remove.data.folderGroups = remove.data.folderGroups.filter(group => group.id !== 'b');
    await h.service.mergeRendererSave(remove);
    const add = envelope(h.data);
    add.data.folderGroups.push(fixture().folderGroups[1]);
    add.sourceRevisions.b = null;
    await h.service.mergeRendererSave(add);
    await h.service.updateProject('b', draft => { draft.items.push(media('new-lifetime')); });
    assert.equal((await h.service.snapshot('b')).revision, 1);
    await assert.rejects(h.service.undo('b', old.undoToken), { code: 'INVALID_UNDO_TOKEN' });
    assert.equal((await h.service.snapshot('b')).items[1].id, 'new-lifetime');
});

test('readProject and renderer save return synchronous objects with a synchronous commit', () => {
    const events = [];
    const h = harness(fixture(), event => events.push(event));
    const project = h.service.readProject('a');
    assert.equal(project.then, undefined);
    assert.equal(project.projectId, 'a');
    assert.equal(project.boardRevision, project.revision);
    assert.deepEqual(project.agentMemory, {});
    const save = envelope(h.data);
    save.data.items[0].x = 42;
    const result = h.service.mergeRendererSave(save);
    assert.equal(result.then, undefined);
    assert.equal(result.ok, true);
    assert.equal(h.data.items[0].x, 42);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'mergeRendererSave');
    assert.deepEqual(events[0].projectIds, ['a']);
    assert.equal(events[0].sourceRevisions.a, 1);
    assert.deepEqual(events[0].data, h.data);
});

test('flat runtime updates replace items, connections and agentMemory with one revision', async () => {
    const h = harness();
    const result = await h.service.updateProject('b', draft => {
        draft.items = [media('one'), media('two')];
        draft.connections = [{ id: 'edge', from: { nodeId: 'one', port: 'image' }, to: { nodeId: 'two', port: 'image' } }];
        draft.agentMemory = { summary: 'Completed', files: ['C:/result.png'] };
    });
    assert.equal(result.revision, 1);
    assert.equal(result.items.length, 2);
    assert.equal(result.connections.length, 1);
    assert.deepEqual(h.service.readProject('b').agentMemory, { summary: 'Completed', files: ['C:/result.png'] });
    assert.equal(h.data.activeGroupId, 'a');
    await h.service.updateProject('b', draft => { draft.agentMemory.summary = 'Reviewed'; });
    assert.equal(h.service.readProject('b').revision, 2);
});

test('manual save reports SERVICE_BUSY for queued writes and never interleaves an async mutator', async () => {
    const h = harness();
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const pending = h.service.updateProject('b', async draft => {
        await barrier;
        draft.items.push(media('generated'));
    });
    const save = envelope(h.data);
    save.data.sidebarClosed = true;
    const queued = h.service.mergeRendererSave(save);
    assert.equal(queued.conflicts[0].code, 'SERVICE_BUSY');
    await Promise.resolve();
    const running = h.service.mergeRendererSave(save);
    assert.equal(running.conflicts[0].code, 'SERVICE_BUSY');
    assert.equal(h.writes, 0);
    assert.equal(h.data.sidebarClosed, false);
    release();
    await pending;
    const retry = h.service.mergeRendererSave(save);
    assert.equal(retry.conflicts[0].code, 'REVISION_CONFLICT');
    assert.equal(retry.data.sidebarClosed, true);
    assert.equal(retry.data.folderGroups[1].savedItems.length, 2);
});

test('pending active canvas revision wins over a stale savedItems mirror but not over source checks', () => {
    const h = harness();
    const save = envelope(h.data);
    save.data.items[0].x = 64;
    save.data.boardRevision = 5;
    save.data.folderGroups[0].boardRevision = 0;
    assert.equal(save.data.folderGroups[0].savedItems[0].x, 0);
    const result = h.service.mergeRendererSave(save);
    assert.equal(result.ok, true);
    assert.equal(result.data.items[0].x, 64);
    assert.equal(result.data.folderGroups[0].savedItems[0].x, 64);
    assert.equal(result.data.boardRevision, 1);
    assert.equal(result.data.folderGroups[0].boardRevision, 1);
    const stale = clone(save);
    stale.data.items[0].x = 128;
    stale.data.boardRevision = 100;
    assert.equal(h.service.mergeRendererSave(stale).conflicts[0].code, 'REVISION_CONFLICT');
    assert.equal(h.data.items[0].x, 64);
});

test('onChange cannot reenter a synchronous renderer commit', () => {
    let nested;
    const h = harness(fixture(), () => {
        nested = h.service.mergeRendererSave({ sidebarClosed: false });
    });
    const result = h.service.mergeRendererSave({ sidebarClosed: true });
    assert.equal(result.ok, true);
    assert.equal(nested.conflicts[0].code, 'SERVICE_BUSY');
    assert.equal(h.data.sidebarClosed, true);
    assert.equal(h.writes, 1);
});

test('whenIdle drains queued writes including failures before routine async renderer save', async () => {
    const h = harness();
    const first = h.service.apply('b', transaction());
    const failure = assert.rejects(h.service.apply('b', transaction('b', 0, 'stale')), { code: 'REVISION_CONFLICT' });
    const idle = h.service.whenIdle();
    const last = h.service.apply('a', transaction('a'));
    await idle;
    const save = envelope(h.data);
    save.data.sidebarClosed = true;
    const result = h.service.mergeRendererSave(save);
    assert.equal(result.ok, true);
    assert.equal(result.data.folderGroups[0].boardRevision, 1);
    assert.equal(result.data.folderGroups[1].boardRevision, 1);
    await Promise.all([first, failure, last]);
});

test('async mutator reload rejects external target changes with or without a revision bump', async () => {
    for (const bump of [true, false]) {
        const h = harness();
        let release;
        let started;
        const barrier = new Promise(resolve => { release = resolve; });
        const entered = new Promise(resolve => { started = resolve; });
        const update = h.service.updateProject('b', async draft => {
            started();
            await barrier;
            draft.items.push(media('runtime-result'));
        });
        await entered;
        const external = h.data;
        external.folderGroups[1].savedItems.push(media('manual-result'));
        if (bump) external.folderGroups[1].boardRevision++;
        h.store.save(external);
        release();
        await assert.rejects(update, error => {
            assert.equal(error.code, 'REVISION_CONFLICT');
            assert.equal(error.details.authoritativeProject.items[1].id, 'manual-result');
            return true;
        });
        await h.service.whenIdle();
        assert.deepEqual(h.data, external);
    }
});

test('async mutator commits onto fresh store and preserves unrelated edits, preferences and project switch', async () => {
    const h = harness();
    let release;
    let started;
    const barrier = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const update = h.service.updateProject('b', async draft => {
        started();
        await barrier;
        draft.agentMemory = { result: 'complete' };
    });
    await entered;
    const external = envelope(h.data);
    external.data.folderGroups[0].savedItems[0].x = 88;
    external.data.folderGroups[0].boardRevision++;
    external.data.sidebarClosed = true;
    switchTo(external, 'b');
    h.store.save(external.data);
    release();
    const result = await update;
    assert.equal(result.revision, 1);
    assert.equal(h.data.activeGroupId, 'b');
    assert.equal(h.data.sidebarClosed, true);
    assert.equal(h.data.folderGroups[0].savedItems[0].x, 88);
    assert.equal(h.data.folderGroups[0].boardRevision, 1);
    assert.equal(h.data.boardRevision, 1);
    assert.deepEqual(h.service.readProject('b').agentMemory, { result: 'complete' });
});

test('node deletion and undo only change references, leaving source files byte-for-byte intact', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-board-service-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filePath = join(directory, 'source.png');
    const bytes = Buffer.from([0, 10, 80, 255, 43]);
    await writeFile(filePath, bytes);
    const data = fixture();
    data.folderGroups[1].savedItems[0].filePath = filePath;
    data.folderGroups[1].plans = [{ id: 'plan', rows: [{ references: [{ itemId: 'b-1', filePath }] }] }];
    const h = harness(data);
    const result = await h.service.apply('b', {
        id: 'delete', projectId: 'b', baseRevision: 0,
        operations: [{ op: 'node.delete', nodeId: 'b-1' }]
    });
    assert.deepEqual(result.snapshot.plans[0].rows[0].references, []);
    assert.deepEqual(await readFile(filePath), bytes);
    const undone = await h.service.undo('b', result.undoToken);
    assert.equal(undone.snapshot.items[0].filePath, filePath);
    assert.equal(undone.snapshot.plans[0].rows[0].references.length, 1);
    assert.deepEqual(await readFile(filePath), bytes);
});
