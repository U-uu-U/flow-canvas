import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { SidebarManager } from './sidebar.js';
import { AgentBoardService } from '../electron-main/agent-board-service.mjs';

const preloadSource = readFileSync(new URL('../electron-main/preload.js', import.meta.url), 'utf8');

function group(id, revision) {
    return {
        id, name: id.toUpperCase(), folders: [`C:/${id}`], defaultSaveFolder: `C:/${id}`,
        savedItems: [
            { id: 'shared-id', kind: 'op', nodeType: 'text', config: { text: id }, x: revision, y: 0 },
            { id: `${id}-output`, kind: 'media', mediaType: 'image', filePath: `C:/${id}/output.png`, x: 100, y: 0 }
        ],
        connections: [{ id: `${id}-edge`, from: { nodeId: 'shared-id', port: 'text' },
            to: { nodeId: `${id}-output`, port: 'source' } }],
        plans: [{ id: `${id}-plan`, title: `${id} plan`, itemIds: ['shared-id'] }],
        savedViewport: { x: revision, y: -revision, scale: 1.5 },
        boardRevision: revision, appliedTransactionKeys: [`${id}-transaction`],
        removedFromBoardPaths: [`C:/${id}/removed.png`], removedFromBoardPathsInitialized: true
    };
}

function harness(t, emptyNextGroup) {
    const a = group('a', 7);
    const b = group('b', 19);
    if (emptyNextGroup) { b.savedItems = []; b.connections = []; b.plans = []; }
    let stored = {
        folderGroups: [a, b], activeGroupId: a.id, items: structuredClone(a.savedItems),
        connections: structuredClone(a.connections), plans: structuredClone(a.plans),
        viewport: structuredClone(a.savedViewport), boardRevision: a.boardRevision,
        appliedTransactionKeys: [...a.appliedTransactionKeys], watchFolders: [...a.folders],
        activeGroupDefaultSaveFolder: a.defaultSaveFolder,
        removedFromBoardPaths: [...a.removedFromBoardPaths], removedFromBoardPathsInitialized: true
    };
    const service = new AgentBoardService({ store: {
        load: () => structuredClone(stored),
        save: data => { stored = structuredClone(data); return true; }
    } });
    const saves = [];
    const rendererWindow = { addEventListener() {} };
    // Exercise the real preload envelope, including revisions remembered before A is removed.
    runInNewContext(preloadSource, {
        window: rendererWindow, process: { platform: 'win32' }, console,
        require(name) {
            assert.equal(name, 'electron');
            return {
                contextBridge: { exposeInMainWorld: (key, value) => { rendererWindow[key] = value; } },
                ipcRenderer: {
                    sendSync(channel, envelope) {
                        if (channel === 'store:loadSync') return structuredClone(stored);
                        assert.equal(channel, 'store:saveSync');
                        const captured = structuredClone(envelope);
                        const result = service.mergeRendererSave(envelope);
                        saves.push({ envelope: captured, result });
                        return result;
                    },
                    emit() {}
                }
            };
        }
    });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    globalThis.window = rendererWindow;
    globalThis.document = { body: { classList: { add() {}, remove() {} } } };
    t.after(() => {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    });
    const pendingSaves = [];
    const save = rendererWindow.flowCanvas.store.save;
    rendererWindow.flowCanvas.store.save = data => {
        const pending = save(data);
        pendingSaves.push(pending);
        return pending;
    };
    const sidebar = Object.assign(Object.create(SidebarManager.prototype), {
        storeData: rendererWindow.flowCanvas.store.loadSync(), listeners: {},
        generationTasks: [], groupTaskAcknowledgedAt: new Map(),
        renderGroups() {}, _restoreActiveGroupWatcherState: async () => {}
    });
    const switches = [];
    sidebar.on('switchGroup', data => switches.push(structuredClone(data)));
    return { sidebar, service, saves, switches, pendingSaves, get stored() { return structuredClone(stored); } };
}

for (const emptyNextGroup of [false, true]) {
    test(`removing active group A activates ${emptyNextGroup ? 'empty' : 'populated'} B without overwriting it through renderer saves`, async t => {
        const h = harness(t, emptyNextGroup);
        const { capturedAt: _beforeCapturedAt, ...before } = h.service.readProject('b');
        const originalGroup = structuredClone(h.stored.folderGroups[1]);
        assert.equal(h.sidebar._removeGroup, SidebarManager.prototype._removeGroup);
        assert.equal(h.sidebar._activateGroup, SidebarManager.prototype._activateGroup);
        assert.equal(h.sidebar._saveStore, SidebarManager.prototype._saveStore);

        h.sidebar._removeGroup('a');
        assert.deepEqual(await Promise.all(h.pendingSaves), [true, true]);
        assert.equal(h.sidebar.storeData.activeGroupId, 'b');
        assert.deepEqual(h.sidebar.storeData.items, originalGroup.savedItems);
        assert.deepEqual(h.sidebar.storeData.connections, originalGroup.connections);
        assert.deepEqual(h.sidebar.storeData.viewport, originalGroup.savedViewport);
        assert.equal(h.sidebar.storeData.boardRevision, originalGroup.boardRevision);
        assert.deepEqual(h.sidebar.storeData.appliedTransactionKeys, originalGroup.appliedTransactionKeys);
        assert.deepEqual(h.switches, [{ folders: originalGroup.folders, items: originalGroup.savedItems,
            connections: originalGroup.connections, viewport: originalGroup.savedViewport, plans: originalGroup.plans }]);

        assert.deepEqual(h.saves[0].envelope.sourceRevisions, { a: 7, b: 19 });
        assert.equal(h.saves[0].envelope.sourceActiveGroupId, 'a');
        assert.equal(h.saves[1].envelope.sourceActiveGroupId, 'b');
        for (const { envelope, result } of h.saves) {
            assert.equal(result.ok, true);
            assert.deepEqual(result.conflicts, []);
            assert.equal(envelope.data.activeGroupId, 'b');
            assert.deepEqual(envelope.data.items, originalGroup.savedItems);
            assert.equal(result.changedProjectIds.includes('b'), false);
            assert.equal(result.sourceRevisions.b, 19);
        }
        const { capturedAt: _afterCapturedAt, ...after } = h.service.readProject('b');
        assert.deepEqual(after, before);
        assert.deepEqual(h.stored.folderGroups, [originalGroup]);
        assert.deepEqual(h.stored.items, originalGroup.savedItems);
        assert.deepEqual(h.stored.connections, originalGroup.connections);
        assert.deepEqual(h.stored.plans, originalGroup.plans);
        assert.deepEqual(h.stored.removedFromBoardPaths, originalGroup.removedFromBoardPaths);
        assert.equal(h.stored.activeGroupDefaultSaveFolder, 'C:/b');
        assert.equal(h.stored.activeGroupId, 'b');
        assert.throws(() => h.service.readProject('a'), { code: 'PROJECT_NOT_FOUND' });
    });
}
