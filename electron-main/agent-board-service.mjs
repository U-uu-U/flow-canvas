import {
    BoardTransactionError,
    createBoardSnapshot,
    normalizeBoardTransaction,
    previewBoardTransaction,
    applyBoardTransaction,
    undoBoardTransaction
} from '../src/board-transaction.js';

const GROUP_BOARD_FIELDS = new Set([
    'savedItems', 'items', 'connections', 'plans', 'savedViewport', 'viewport',
    'boardRevision', 'appliedTransactionKeys'
]);
const TOP_MIRRORS = new Set([
    'folderGroups', 'activeGroupId', 'items', 'connections', 'plans', 'viewport',
    'boardRevision', 'appliedTransactionKeys', 'watchFolders',
    'activeGroupDefaultSaveFolder', 'removedFromBoardPaths', 'removedFromBoardPathsInitialized'
]);
const clone = value => value === undefined ? undefined : structuredClone(value);
const own = (object, key) => Object.hasOwn(object, key);
const revision = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

// JSON object order is immaterial; array order (including board stacking) is not.
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort()
            .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
    }
    return value;
}

function equal(a, b) {
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function fail(code, message, details = {}) {
    throw new BoardTransactionError(code, message, details);
}

function requireGroup(data, projectId) {
    const group = data.folderGroups?.find(entry => entry.id === projectId);
    if (!group) fail('PROJECT_NOT_FOUND', `Project not found: ${projectId}`, { projectId });
    return group;
}

function project(data, projectId, options) {
    const group = requireGroup(data, projectId);
    const active = data.activeGroupId === projectId;
    const metadata = Object.fromEntries(Object.entries(group)
        .filter(([key]) => !GROUP_BOARD_FIELDS.has(key)));
    metadata.folders ??= [];
    metadata.defaultSaveFolder ??= null;
    return {
        snapshot: createBoardSnapshot({
            projectId,
            boardRevision: group.boardRevision,
            items: active && Array.isArray(data.items) ? data.items : group.savedItems ?? group.items,
            connections: active && Array.isArray(data.connections) ? data.connections : group.connections,
            plans: group.plans,
            viewport: (active ? data.viewport : null) ?? group.savedViewport ?? group.viewport ?? {},
            appliedTransactionKeys: group.appliedTransactionKeys
        }, options),
        metadata: clone(metadata),
        sourceRevision: revision(group.boardRevision)
    };
}

function content(value) {
    const { items, connections, plans, viewport } = value.snapshot;
    return { metadata: value.metadata, items, connections, plans, viewport };
}

function publicProject(value) {
    return {
        ...clone(value.metadata), ...clone(value.snapshot),
        boardRevision: value.snapshot.revision,
        sourceRevision: value.sourceRevision,
        agentMemory: clone(value.metadata.agentMemory ?? {})
    };
}

function putProject(data, value) {
    const { snapshot, metadata } = value;
    const group = requireGroup(data, snapshot.projectId);
    const next = {
        ...clone(metadata),
        id: group.id,
        savedItems: clone(snapshot.items),
        connections: clone(snapshot.connections),
        plans: clone(snapshot.plans),
        savedViewport: clone(snapshot.viewport),
        boardRevision: snapshot.revision,
        appliedTransactionKeys: clone(snapshot.appliedTransactionKeys)
    };
    data.folderGroups[data.folderGroups.indexOf(group)] = next;
    if (data.activeGroupId === group.id) mirrorActive(data);
}

function mirrorActive(data) {
    const group = data.folderGroups.find(entry => entry.id === data.activeGroupId);
    if (!group) {
        Object.assign(data, {
            items: [], connections: [], plans: [], boardRevision: 0,
            appliedTransactionKeys: [], viewport: { x: 0, y: 0, scale: 1 },
            watchFolders: [], activeGroupDefaultSaveFolder: null,
            removedFromBoardPaths: [], removedFromBoardPathsInitialized: false
        });
        return;
    }
    Object.assign(data, {
        items: clone(group.savedItems ?? group.items ?? []),
        connections: clone(group.connections ?? []), plans: clone(group.plans ?? []),
        boardRevision: revision(group.boardRevision),
        appliedTransactionKeys: clone(group.appliedTransactionKeys ?? []),
        viewport: clone(group.savedViewport ?? group.viewport ?? { x: 0, y: 0, scale: 1 }),
        watchFolders: clone(group.folders ?? []),
        activeGroupDefaultSaveFolder: group.defaultSaveFolder ?? null,
        removedFromBoardPaths: clone(group.removedFromBoardPaths ?? []),
        removedFromBoardPathsInitialized: group.removedFromBoardPathsInitialized === true
    });
}

function sourceRevisions(data) {
    return Object.fromEntries(data.folderGroups.map(group => [group.id, revision(group.boardRevision)]));
}

/**
 * readProject, snapshot, preview and mergeRendererSave are synchronous.
 * apply, undo and updateProject return Promises sharing one FIFO. Reads expose
 * the last committed state. Synchronous renderer saves report SERVICE_BUSY
 * while that FIFO is nonempty; the caller must retry after draining Agent work.
 * Use one instance per store; route every writer through it. Await renderer flush
 * before Agent work. Async mutators must not await another method on this instance.
 * Undo records are process-local; idempotency keys are persisted in each project.
 */
export class AgentBoardService {
    #store;
    #onChange;
    #tail = Promise.resolve();
    #pending = 0;
    #saving = false;
    #undo = new Map();

    constructor({ store, onChange } = {}) {
        if (typeof store?.load !== 'function' || typeof store?.save !== 'function') {
            throw new TypeError('store.load and store.save are required');
        }
        if (onChange != null && typeof onChange !== 'function') throw new TypeError('Invalid onChange');
        this.#store = store;
        this.#onChange = onChange;
    }

    #enqueue(action) {
        this.#pending++;
        const result = this.#tail.then(action).finally(() => { this.#pending--; });
        this.#tail = result.catch(() => {});
        return result;
    }

    /** Await queued mutations before calling mergeRendererSave from async IPC.
     * Do not call this from a mutator; it would wait for itself.
     */
    async whenIdle() {
        while (this.#pending > 0) await this.#tail;
    }

    #load() {
        const loaded = this.#store.load();
        if (loaded?.then) fail('SYNC_STORE_REQUIRED', 'store.load must be synchronous');
        const data = clone(loaded);
        if (!data || typeof data !== 'object' || !Array.isArray(data.folderGroups)) {
            fail('INVALID_STORE', 'Store must contain folderGroups');
        }
        return data;
    }

    #save(data, type, projectIds) {
        this.#saving = true;
        try {
            if (this.#store.save(clone(data)) !== true) fail('SAVE_FAILED', 'Store rejected the synchronous write');
            // Notification failures must not turn a committed write into a failed retry.
            try {
                const notification = this.#onChange?.({
                    type, projectIds: [...projectIds], data: clone(data),
                    sourceRevisions: sourceRevisions(data), activeGroupId: data.activeGroupId
                });
                Promise.resolve(notification).catch(() => {});
            } catch { /* The persisted result remains authoritative. */ }
        } finally {
            this.#saving = false;
        }
    }

    snapshot(projectId, options = {}) {
        return project(this.#load(), projectId, clone(options)).snapshot;
    }

    readProject(projectId) {
        return publicProject(project(this.#load(), projectId));
    }

    preview(projectId, transaction) {
        const current = project(this.#load(), projectId).snapshot;
        return previewBoardTransaction(current, this.#retryTransaction(current, clone(transaction)));
    }

    #retryTransaction(current, transaction) {
        const normalized = normalizeBoardTransaction(transaction);
        // The pure helper checks revision before idempotency. A persisted key wins
        // on retries, but the helper must still validate the target project.
        if (current.appliedTransactionKeys.includes(normalized.idempotencyKey)) {
            normalized.baseRevision = current.revision;
        }
        return normalized;
    }

    apply(projectId, transaction) {
        const captured = clone(transaction);
        return this.#enqueue(() => {
            const data = this.#load();
            const current = project(data, projectId);
            const result = applyBoardTransaction(current.snapshot, this.#retryTransaction(current.snapshot, captured));
            if (!result.duplicate) {
                putProject(data, { ...current, snapshot: result.snapshot });
                this.#save(data, 'apply', [projectId]);
                const records = this.#undo.get(projectId) ?? new Map();
                records.set(result.undoToken, clone(result.undoRecord));
                if (records.size > 200) records.delete(records.keys().next().value);
                this.#undo.set(projectId, records);
            }
            return result;
        });
    }

    undo(projectId, undoToken) {
        return this.#enqueue(() => {
            const data = this.#load();
            const current = project(data, projectId);
            const record = this.#undo.get(projectId)?.get(undoToken);
            const result = undoBoardTransaction(current.snapshot, record);
            putProject(data, { ...current, snapshot: result.snapshot });
            this.#save(data, 'undo', [projectId]);
            this.#undo.get(projectId).delete(undoToken);
            return result;
        });
    }

    /** Mutate the flat readProject shape: draft.items, connections, plans,
     * folders, defaultSaveFolder, agentMemory, etc., optionally asynchronously.
     * Identity, revision and idempotency keys are service-owned. Return any JSON
     * result via `value`; returning an object does not replace the draft.
     */
    updateProject(projectId, mutator) {
        return this.#enqueue(async () => {
            if (typeof mutator !== 'function') throw new TypeError('mutator must be a function');
            const data = this.#load();
            const current = project(data, projectId);
            const draft = publicProject(current);
            const value = clone(await mutator(draft));
            if (draft.id !== projectId || draft.projectId !== projectId
                || draft.revision !== current.snapshot.revision
                || draft.boardRevision !== current.snapshot.revision
                || !equal(draft.appliedTransactionKeys, current.snapshot.appliedTransactionKeys)) {
                fail('INVALID_PROJECT_UPDATE', 'Project identity, revision and transaction keys are read-only');
            }
            for (const key of ['items', 'connections', 'plans']) {
                if (!Array.isArray(draft[key])) fail('INVALID_PROJECT_UPDATE', `${key} must be an array`);
            }
            const snapshotFields = new Set([...Object.keys(current.snapshot), 'boardRevision', 'sourceRevision']);
            const next = {
                snapshot: createBoardSnapshot(draft),
                metadata: Object.fromEntries(Object.entries(draft).filter(([key]) => !snapshotFields.has(key)))
            };
            // Supplying the default memory object on reads is not itself an edit.
            if (!own(current.metadata, 'agentMemory') && equal(next.metadata.agentMemory, {})) delete next.metadata.agentMemory;
            if (Object.keys(next.metadata).some(key => GROUP_BOARD_FIELDS.has(key))) {
                fail('INVALID_PROJECT_UPDATE', 'Use items and viewport, not savedItems or savedViewport');
            }
            const changed = !equal(content(current), content(next));
            // The callback may await external work. Re-read instead of saving its
            // original whole-store copy, including changes from other writers.
            const latestData = this.#load();
            const latest = project(latestData, projectId);
            if (changed) {
                if (latest.sourceRevision !== current.sourceRevision
                    || !equal(content(latest), content(current))
                    || !equal(latest.snapshot.appliedTransactionKeys, current.snapshot.appliedTransactionKeys)) {
                    fail('REVISION_CONFLICT', 'Project changed while the mutator was running', {
                        projectId, expectedRevision: current.sourceRevision,
                        actualRevision: latest.sourceRevision, authoritativeProject: publicProject(latest)
                    });
                }
                next.snapshot.revision = current.snapshot.revision + 1;
                putProject(latestData, next);
                this.#save(latestData, 'updateProject', [projectId]);
            }
            return { ok: true, changed, value, ...publicProject(project(latestData, projectId)) };
        });
    }

    /**
     * incoming = { data, sourceRevisions, sourceActiveGroupId }.
     * sourceRevisions are the last authoritative revisions the renderer READ,
     * never its locally incremented boardRevision. Use null for a new project.
     * A supplied folderGroups array is complete: omissions request deletion.
     * Without a source revision, only canonically unchanged projects are accepted.
     * Raw store data is supported with that same conservative rule. Switching the
     * active project requires sourceActiveGroupId (null is valid).
     * Conflicts are per-project: preferences and unrelated projects still save.
     * Hydrate renderer from returned data/sourceRevisions on revision conflicts.
     * SERVICE_BUSY writes nothing: retain the pending save and retry after the
     * queued work settles, then reconcile the returned authoritative data.
     */
    mergeRendererSave(incoming) {
        const captured = clone(incoming);
        {
            const wrapped = captured && own(captured, 'data');
            const patch = wrapped ? captured.data : captured;
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('INVALID_RENDERER_SAVE', 'Invalid data');
            const sources = wrapped ? captured.sourceRevisions ?? {} : {};
            const data = this.#load();
            if (this.#pending > 0 || this.#saving) {
                return {
                    ok: false, changed: false, conflicts: [{ code: 'SERVICE_BUSY', projectId: null }],
                    changedProjectIds: [], data, sourceRevisions: sourceRevisions(data), activeGroupId: data.activeGroupId
                };
            }
            const before = clone(data);
            const conflicts = [];
            const changedProjectIds = [];
            const lifecycleProjectIds = [];
            const reject = (projectId, code, actualRevision) => conflicts.push({
                projectId, code, sourceRevision: sources[projectId] ?? null, actualRevision
            });
            for (const [key, value] of Object.entries(patch)) {
                if (!TOP_MIRRORS.has(key)) data[key] = clone(value);
            }
            if (own(patch, 'folderGroups')) {
                if (!Array.isArray(patch.folderGroups)) fail('INVALID_RENDERER_SAVE', 'folderGroups must be an array');
                const ids = new Set();
                for (const group of patch.folderGroups) {
                    if (!group || typeof group.id !== 'string' || !group.id || ids.has(group.id)) {
                        fail('INVALID_RENDERER_SAVE', 'Project IDs must be unique nonempty strings');
                    }
                    ids.add(group.id);
                    const existing = before.folderGroups.find(entry => entry.id === group.id);
                    const candidate = project(patch, group.id);
                    if (!existing) {
                        if (!own(sources, group.id) || sources[group.id] !== null) {
                            reject(group.id, 'SOURCE_REVISION_REQUIRED', null);
                            continue;
                        }
                        candidate.snapshot.revision = 0;
                        candidate.snapshot.appliedTransactionKeys = [];
                        data.folderGroups.push({ id: group.id });
                        lifecycleProjectIds.push(group.id);
                    } else {
                        const current = project(before, group.id);
                        if (equal(content(candidate), content(current))) continue;
                        if (!own(sources, group.id) || sources[group.id] !== current.sourceRevision) {
                            reject(group.id, own(sources, group.id) ? 'REVISION_CONFLICT' : 'SOURCE_REVISION_REQUIRED', current.sourceRevision);
                            continue;
                        }
                        candidate.snapshot.revision = current.sourceRevision + 1;
                        candidate.snapshot.appliedTransactionKeys = current.snapshot.appliedTransactionKeys;
                    }
                    putProject(data, candidate);
                    changedProjectIds.push(group.id);
                }
                for (const group of before.folderGroups) {
                    if (ids.has(group.id)) continue;
                    if (!own(sources, group.id) || sources[group.id] !== revision(group.boardRevision)) {
                        reject(group.id, 'REVISION_CONFLICT', revision(group.boardRevision));
                        continue;
                    }
                    data.folderGroups = data.folderGroups.filter(entry => entry.id !== group.id);
                    changedProjectIds.push(group.id);
                    lifecycleProjectIds.push(group.id);
                }
            } else if (['items', 'connections', 'plans', 'boardRevision'].some(key => own(patch, key))) {
                fail('INVALID_RENDERER_SAVE', 'Board saves require folderGroups');
            }
            if (own(patch, 'activeGroupId') && patch.activeGroupId !== before.activeGroupId) {
                if (!wrapped || !own(captured, 'sourceActiveGroupId') || captured.sourceActiveGroupId !== before.activeGroupId) {
                    reject(patch.activeGroupId, 'ACTIVE_GROUP_CONFLICT', null);
                } else if (patch.activeGroupId !== null && !data.folderGroups.some(group => group.id === patch.activeGroupId)) {
                    reject(patch.activeGroupId, 'PROJECT_NOT_FOUND', null);
                } else {
                    data.activeGroupId = patch.activeGroupId;
                }
            }
            if (own(patch, 'folderGroups') || own(patch, 'activeGroupId')) {
                if (!data.folderGroups.some(group => group.id === data.activeGroupId)) data.activeGroupId = null;
                // Retained active groups may have fresher top-level items than savedItems.
                const active = data.folderGroups.find(group => group.id === data.activeGroupId);
                if (active && !changedProjectIds.includes(active.id) && before.activeGroupId === active.id) {
                    putProject(data, project(before, active.id));
                }
                mirrorActive(data);
            }
            const changed = !equal(before, data);
            if (changed) this.#save(data, 'mergeRendererSave', changedProjectIds);
            // Deleting and reusing an ID starts a new project lifetime, even if
            // its numeric revision later happens to match an old undo record.
            for (const id of lifecycleProjectIds) this.#undo.delete(id);
            return {
                ok: conflicts.length === 0, changed, conflicts, changedProjectIds,
                data: clone(data), sourceRevisions: sourceRevisions(data), activeGroupId: data.activeGroupId
            };
        }
    }
}
