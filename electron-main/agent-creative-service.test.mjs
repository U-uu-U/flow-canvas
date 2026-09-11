import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentBoardService } from './agent-board-service.mjs';
import { AgentCreativeService } from './agent-creative-service.mjs';
import planCore from '../shared/plan-service-core.cjs';
import { getPorts, topoOrder } from '../src/graph-model.js';
import { expandGenerationPrompts } from '../src/node-types.js';

const clone = value => structuredClone(value);
const media = (id, title = id) => ({ id, title, kind: 'media', mediaType: 'image',
    filePath: `C:/assets/${id}.png`, x: 10, y: 20, width: 320 });
const op = (id, nodeType = 'image') => ({ id, kind: 'op', nodeType, title: id, x: 50, y: 80,
    config: { prompt: `Original ${id}` }, runStatus: 'idle' });
const code = expected => error => error.code === expected;

function completedRun() {
    const firstResult = { nodeIds: ['output-1'], filePaths: ['C:/results/first.png'], sourceNodeId: 'g1' };
    const secondResult = { nodeIds: ['output-2'], filePaths: ['C:/results/second.mp4'], sourceNodeId: 'g2' };
    return { id: 'run-1', projectId: 'p', status: 'completed',
        providerRef: { id: 'private-text-provider', endpoint: 'https://private.test/v1', apiKey: 'opaque-credential' },
        steps: [
            { id: 'original-step-1', nodeId: 'g1', kind: 'image', status: 'completed', title: 'Compose',
                prompt: 'Reference 1 supplies style; reference 2 supplies subject.',
                config: { prompt: 'Older unexpanded prompt', ratio: '16:9', count: 3, resolutionTier: '2K',
                    providerId: 'image-provider', model: 'specific-image-model' },
                references: [{ nodeId: 'b', filePath: 'C:/assets/b.png' }, { nodeId: 'a', filePath: 'C:/assets/a.png' }],
                result: firstResult },
            { id: 'original-step-2', nodeId: 'g2', kind: 'video', status: 'completed', title: 'Animate',
                prompt: 'Animate reference 1 with reference 2 lighting.',
                config: { prompt: 'Older video prompt', duration: 5, resolution: '720p', generateAudio: true },
                references: [{ nodeId: 'g1', filePath: 'C:/results/first.png' }, { nodeId: 'b', filePath: 'C:/assets/b.png' }],
                result: secondResult }
        ], results: [{ stepId: 'original-step-1', ...firstResult }, { stepId: 'original-step-2', ...secondResult }] };
}

function harness(run = completedRun()) {
    const items = [media('a', 'Subject'), media('b', 'Style'), media('c', 'Replacement'),
        op('g1'), op('g2', 'video'), media('output-1'), { ...media('output-2'), mediaType: 'video' }];
    const group = { id: 'p', savedItems: clone(items), connections: [], plans: [], boardRevision: 0,
        folders: ['C:/assets'], defaultSaveFolder: 'C:/results', agentMemory: { brief: 'Keep user work' } };
    let data = { folderGroups: [group, { id: 'other', savedItems: [media('foreign')], plans: [], connections: [] }],
        activeGroupId: 'p', items, connections: [], plans: [] };
    let writes = 0, rejectSave = false;
    const store = { load: () => clone(data), save: next => {
        if (rejectSave) return false;
        data = clone(next); writes++; return true;
    } };
    const board = new AgentBoardService({ store });
    const transactions = [];
    const apply = board.apply.bind(board);
    board.apply = (projectId, transaction) => { transactions.push(clone(transaction)); return apply(projectId, transaction); };
    const service = new AgentCreativeService({ board, getRun: id => id === run?.id ? clone(run) : undefined });
    return { board, service, run, store, transactions, get data() { return clone(data); }, get writes() { return writes; },
        rejectSave: () => { rejectSave = true; } };
}

const save = h => h.service.workflowSave('p', { runId: h.run.id, name: 'Reference motion' });
const create = (h, extra = {}) => h.service.documentCreate('p', { title: 'Production', rows: [
    { id: 'r1', cells: { title: 'First', notes: 'User notes', custom: 'Untouched' }, references: [{ itemId: 'a' }] },
    { id: 'r2', cells: { title: 'Second', notes: 'Other notes' } }
], ...extra });

test('documents live in project plans and remain editable/exportable through PlanService', async () => {
    const h = harness();
    const result = await create(h);
    assert.equal(result.revision, 1);
    assert.equal(result.document.templateId, 'table');
    assert.equal(h.data.plans[0].id, result.document.id);
    const storeData = h.data;
    const plans = new planCore.PlanService(storeData);
    plans.updateRow(result.document.id, 'r1', { cells: { notes: 'Renderer edit' } });
    assert.match(plans.exportPlanMarkdown(result.document.id), /Renderer edit/);
    assert.equal(plans.getPlan(result.document.id).node.width, planCore.DEFAULT_PLAN_NODE_WIDTH);
    assert.deepEqual(h.board.readProject('p').agentMemory, { brief: 'Keep user work' });
});

for (const [templateId, key] of [['table', 'content'], ['script', 'dialogue'], ['characters', 'appearance'], ['shots', 'framing']]) {
    test(`${templateId} template has meaningful columns and survives the shared normalizer`, async () => {
        const h = harness();
        const { document } = await create(h, { templateId });
        assert.ok(document.columns.some(column => column.key === key));
        const data = h.data;
        const plans = new planCore.PlanService(data);
        assert.equal(plans.getPlan(document.id).templateId, undefined);
        h.store.save(data);
        assert.equal(h.service.documentGet('p', { documentId: document.id }).document.templateId, templateId);
        assert.equal(h.service.documentList('p').documents[0].templateId, templateId);
    });
}

test('create accepts custom columns and zero rows use existing default normalization', async () => {
    const h = harness();
    const columns = [{ key: 'beat', label: 'Story beat', width: 225 }];
    const { document } = await create(h, { columns, rows: [] });
    assert.deepEqual(document.columns, columns);
    assert.equal(document.rows.length, 3);
    assert.equal(new Set(document.rows.map(row => row.id)).size, 3);
    const second = await create(h, { rows: [{ cells: { beat: 'Arrival' } }] });
    assert.notEqual(second.document.id, document.id);
    assert.ok(second.document.rows[0].id);
});

test('document row updates merge stable IDs and preserve unrelated user edits and plan layout', async () => {
    const h = harness();
    const initial = await create(h);
    await h.board.updateProject('p', project => {
        const plan = project.plans[0];
        plan.node = { x: 123, y: 456, width: 1500, height: 720 };
        plan.rows[0].cells.custom = 'Renderer custom edit';
        plan.rows[1].cells.notes = 'Renderer second-row edit';
        project.plans.push({ ...clone(plan), id: 'unrelated', title: 'Other plan', customMetadata: 'Keep' });
    });
    const before = h.board.readProject('p');
    const result = await h.service.documentUpdate('p', { documentId: initial.document.id,
        baseRevision: before.revision, rows: [{ id: 'r1', cells: { title: 'Revised' } }] });
    assert.equal(result.document.rows[0].cells.custom, 'Renderer custom edit');
    assert.equal(result.document.rows[0].cells.notes, 'User notes');
    assert.deepEqual(result.document.rows[0].references, initial.document.rows[0].references);
    assert.deepEqual(result.document.rows[1], before.plans[0].rows[1]);
    assert.deepEqual(result.document.node, before.plans[0].node);
    assert.deepEqual(h.board.readProject('p').plans[1], before.plans[1]);
});

test('update appends new row IDs, deletes specific rows, and repeated equal patches are no-ops', async () => {
    const h = harness();
    const { document, revision } = await create(h);
    const patch = { documentId: document.id, rows: [{ id: 'r1', delete: true },
        { id: 'r3', cells: { title: 'Third', value: 42 } }] };
    const result = await h.service.documentUpdate('p', { ...patch, baseRevision: revision });
    assert.deepEqual(result.document.rows.map(row => row.id), ['r2', 'r3']);
    assert.equal(result.document.rows[1].cells.value, '42');
    const writes = h.writes;
    const again = await h.service.documentUpdate('p', { ...patch, baseRevision: result.revision });
    assert.equal(again.changed, false);
    assert.equal(h.writes, writes);
    assert.equal(again.document.updatedAt, result.document.updatedAt);
});

test('title and column edits preserve rows including cells for removed columns', async () => {
    const h = harness();
    const { document, revision } = await create(h);
    const result = await h.service.documentUpdate('p', { documentId: document.id, baseRevision: revision,
        title: 'New title', columns: [{ key: 'custom', label: 'Custom', width: 260 }] });
    assert.equal(result.document.title, 'New title');
    assert.deepEqual(result.document.rows, document.rows);
    assert.deepEqual(result.document.columns, [{ key: 'custom', label: 'Custom', width: 260 }]);
});

test('document references derive paths and names from real project nodes in supplied order', async () => {
    const h = harness();
    const { document } = await create(h, { rows: [{ cells: { assets: 'User description' }, references: [
        { itemId: 'b', filePath: 'C:/forbidden/secret', name: 'Forged', kind: 'output' }, { itemId: 'a' }
    ] }] });
    assert.deepEqual(document.rows[0].references, [
        { itemId: 'b', filePath: 'C:/assets/b.png', name: 'Style', kind: 'source' },
        { itemId: 'a', filePath: 'C:/assets/a.png', name: 'Subject', kind: 'source' }
    ]);
    assert.equal(document.rows[0].cells.assets, 'User description');
});

test('references can use generator result stacks and explicit empty arrays clear references', async () => {
    const h = harness();
    await h.board.updateProject('p', project => {
        project.items.find(node => node.id === 'g1').resultEntries = [{ filePath: 'C:/outputs/stack.png' }];
    });
    const result = await create(h, { rows: [{ id: 'r', cells: {}, references: [{ itemId: 'g1' }] }] });
    assert.equal(result.document.rows[0].references[0].filePath, 'C:/outputs/stack.png');
    const updated = await h.service.documentUpdate('p', { documentId: result.document.id, baseRevision: result.revision,
        rows: [{ id: 'r', references: [] }] });
    assert.deepEqual(updated.document.rows[0].references, []);
});

test('path-only, foreign, nonexistent and pathless document references cannot be persisted', async () => {
    for (const [reference, error] of [[{ filePath: 'C:/secret' }, 'INVALID_ARGUMENTS'],
        [{ itemId: 'foreign' }, 'NODE_NOT_FOUND'], [{ itemId: 'missing' }, 'NODE_NOT_FOUND'],
        [{ itemId: 'g1' }, 'REFERENCE_UNAVAILABLE']]) {
        const h = harness();
        await assert.rejects(create(h, { rows: [{ cells: {}, references: [reference] }] }), code(error));
        assert.equal(h.writes, 0);
    }
});

test('stale revisions fail atomically even when the patch would be a no-op', async () => {
    const h = harness();
    const { document, revision } = await create(h);
    await h.board.updateProject('p', project => { project.agentMemory.brief = 'User changed the project'; });
    const before = h.data;
    await assert.rejects(h.service.documentUpdate('p', { documentId: document.id, baseRevision: revision,
        rows: [{ id: 'r1', cells: { title: 'First' } }] }), code('REVISION_CONFLICT'));
    assert.deepEqual(h.data, before);
    await assert.rejects(h.service.documentUpdate('p', { documentId: document.id }), code('INVALID_ARGUMENTS'));
});

test('revision check occurs inside the FIFO after earlier queued writes', async () => {
    const h = harness();
    const { document, revision } = await create(h);
    const earlier = h.board.updateProject('p', project => { project.plans[0].title = 'Earlier edit'; });
    const later = h.service.documentUpdate('p', { documentId: document.id, baseRevision: revision, title: 'Stale edit' });
    await earlier;
    await assert.rejects(later, code('REVISION_CONFLICT'));
    assert.equal(h.service.documentGet('p', { documentId: document.id }).document.title, 'Earlier edit');
});

test('invalid create shapes and duplicate IDs/columns fail without writes', async () => {
    for (const patch of [{ templateId: 'unknown' }, { columns: [] }, { columns: [{ key: 'x', label: 'X', width: -1 }] },
        { columns: [{ key: 'x', label: 'X' }, { key: 'x', label: 'Again' }] },
        { rows: [{ id: 'same', cells: {} }, { id: 'same', cells: {} }] },
        { rows: [{ cells: { nested: { invalid: true } } }] }, { rows: [{ cells: {}, delete: true }] }]) {
        const h = harness();
        await assert.rejects(create(h, patch), code('INVALID_ARGUMENTS'));
        assert.equal(h.writes, 0);
    }
});

test('invalid later row reference rolls back earlier row edits and does not mutate caller input', async () => {
    const h = harness();
    const { document, revision } = await create(h);
    const input = { documentId: document.id, baseRevision: revision,
        rows: [{ id: 'r1', cells: { notes: 'Must roll back' } }, { id: 'r2', references: [{ itemId: 'missing' }] }] };
    const before = h.data, captured = clone(input);
    await assert.rejects(h.service.documentUpdate('p', input), code('NODE_NOT_FOUND'));
    assert.deepEqual(h.data, before);
    assert.deepEqual(input, captured);
});

test('document reads are detached, project-scoped and report missing documents/projects', async () => {
    const h = harness();
    const { document } = await create(h);
    const read = h.service.documentGet('p', { documentId: document.id });
    read.document.rows[0].cells.title = 'Changed outside service';
    assert.equal(h.service.documentGet('p', { documentId: document.id }).document.rows[0].cells.title, 'First');
    assert.deepEqual(h.service.documentList('other').documents, []);
    assert.throws(() => h.service.documentGet('other', { documentId: document.id }), code('DOCUMENT_NOT_FOUND'));
    assert.throws(() => h.service.documentList('missing'), code('PROJECT_NOT_FOUND'));
});

test('workflows save versioned recipes, ordered slots, internal dependencies and fixed allowlists', async () => {
    const h = harness();
    const { workflow, revision } = await save(h);
    assert.equal(revision, 1);
    assert.equal(workflow.version, 1);
    assert.equal(workflow.schemaVersion, 1);
    assert.deepEqual(workflow.inputSlots, [
        { id: 'input-1', label: 'Style', kind: 'image' }, { id: 'input-2', label: 'Subject', kind: 'image' }
    ]);
    assert.deepEqual(workflow.steps[0].references, [{ inputSlotId: 'input-1' }, { inputSlotId: 'input-2' }]);
    assert.deepEqual(workflow.steps[1].references, [{ stepId: 'step-1' }, { inputSlotId: 'input-1' }]);
    assert.deepEqual(workflow.steps[0].modelPreference, { kind: 'image' });
    assert.equal(workflow.steps[0].config.count, 1);
    assert.equal(workflow.steps[0].config.prompt, h.run.steps[0].prompt);
    assert.ok(workflow.tools.includes('flow_canvas.graph.run'));
    assert.equal(workflow.acceptance.length, 3);
    assert.equal(h.transactions.length, 0);
});

test('slot identity is node ID rather than shared path and reference indices never sort', async () => {
    const h = harness();
    await h.board.updateProject('p', project => { project.items.find(node => node.id === 'b').filePath = 'C:/assets/a.png'; });
    const { workflow } = await save(h);
    assert.equal(workflow.inputSlots.length, 2);
    const result = await h.service.workflowInstantiate('p', { skillId: workflow.id, referenceNodeIds: ['c', 'a'] });
    const incoming = h.board.readProject('p').connections.filter(edge => edge.to.nodeId === result.nodeIds[0]);
    assert.deepEqual(incoming.map(edge => edge.from.nodeId), ['c', 'a']);
});

test('save removes credentials, provider bindings, URLs and local paths even from free text', async () => {
    const h = harness();
    Object.assign(h.run.steps[0].config, { api_key: 'secret-config-value', token: 'arbitrary-token-value',
        nested: { headers: { Authorization: 'Bearer nested-value' }, path: '/private/nested.png' },
        endpoint: 'https://internal.test/generate', sourceProviderId: 'secret-provider-id',
        referenceCitationIds: ['a', 'b'], referenceCitationOffsets: { a: 20 },
        agentCompiledPrompt: 'Must not override a user change', targetDir: 'C:/hardcoded/folder' });
    h.run.steps[0].prompt = 'Reference 1: secret-config-value arbitrary-token-value secret-provider-id opaque-credential '
        + 'https://example.test/key?a=1 C:\\private\\image.png /home/user/image.png ./local/image.png '
        + '"C:/path with spaces/image.png" \\\\server\\share\\file.png sk-exampletoken123 token=raw-key-value';
    const before = clone(h.run);
    const { workflow } = await h.service.workflowSave('p', { runId: h.run.id,
        name: 'Portable https://secret.test/name', instruction: 'Use /tmp/private.png and private-text-provider' });
    const serialized = JSON.stringify(workflow);
    for (const forbidden of ['secret-config-value', 'arbitrary-token-value', 'secret-provider-id', 'opaque-credential',
        'https://', 'C:', '/home/', '/tmp/', './local', 'path with spaces', 'server', 'sk-exampletoken123',
        'raw-key-value', 'private-text-provider', 'image-provider', 'specific-image-model', 'referenceCitationIds',
        'agentCompiledPrompt', 'nested-value', 'providerId', 'targetDir', 'filePath']) {
        assert.ok(!serialized.includes(forbidden), `Leaked ${forbidden}`);
    }
    assert.match(workflow.steps[0].config.prompt, /Reference 1/);
    assert.equal(workflow.steps[0].config.ratio, '16:9');
    assert.deepEqual(h.run, before);
});

test('save retries are idempotent and changed same-name recipes have unique version IDs', async () => {
    const h = harness();
    const [first, duplicate] = await Promise.all([save(h), save(h)]);
    assert.equal(first.workflow.id, duplicate.workflow.id);
    assert.equal(duplicate.changed, false);
    assert.equal(h.writes, 1);
    h.run.steps[0].prompt = 'Changed creative requirement';
    const next = await save(h);
    assert.equal(next.workflow.version, 2);
    assert.notEqual(next.workflow.id, first.workflow.id);
    assert.deepEqual(h.service.workflowList('p').workflows.map(entry => entry.version), [1, 2]);
    assert.equal((await save(h)).workflow.id, next.workflow.id);
});

test('only fully completed runs with completed result-bearing steps may be saved', async () => {
    for (const status of ['partial_failed', 'failed', 'running', 'awaiting_confirmation', 'canceled', 'interrupted']) {
        const h = harness(); h.run.status = status;
        await assert.rejects(save(h), code('RUN_NOT_COMPLETED'));
        assert.equal(h.writes, 0);
    }
    for (const mutate of [run => { run.steps = []; }, run => { run.steps[0].status = 'failed'; },
        run => { delete run.steps[0].config; }, run => { delete run.steps[0].references; },
        run => { delete run.steps[0].result; run.results = []; }, run => { run.steps[0].kind = 'shell'; }]) {
        const h = harness(); mutate(h.run);
        await assert.rejects(save(h), code('INVALID_WORKFLOW'));
        assert.equal(h.writes, 0);
    }
    const h = harness(); h.run.status = 'COMPLETED'; h.run.steps.forEach(step => { step.status = 'COMPLETED'; });
    assert.ok((await save(h)).workflow.id);
});

test('run ownership and unknown runs are checked before workflow persistence', async () => {
    const h = harness();
    await assert.rejects(h.service.workflowSave('p', { runId: 'missing', name: 'Missing' }), code('RUN_NOT_FOUND'));
    await assert.rejects(h.service.workflowSave('other', { runId: h.run.id, name: 'Foreign' }), code('PROJECT_MISMATCH'));
    assert.equal(h.writes, 0);
});

test('result-node references become dependencies and results may come from run.results', async () => {
    const h = harness();
    h.run.steps[1].references[0].nodeId = 'output-1';
    delete h.run.steps[0].result;
    const { workflow } = await save(h);
    assert.deepEqual(workflow.steps[1].references[0], { stepId: 'step-1' });
    assert.equal(workflow.inputSlots.length, 2);
});

test('expanded same-source steps stay separate and source dependencies bind the first result', async () => {
    const h = harness();
    const extra = clone(h.run.steps[0]);
    extra.id = 'another-expanded-step'; extra.prompt = 'Second expanded prompt'; extra.result.nodeIds = ['extra-result'];
    h.run.steps.splice(1, 0, extra);
    const { workflow } = await save(h);
    assert.equal(workflow.steps.length, 3);
    assert.deepEqual(workflow.steps[2].references[0], { stepId: 'step-1' });
    const result = await h.service.workflowInstantiate('p', { skillId: workflow.id, referenceNodeIds: ['b', 'a'] });
    const nodes = h.board.readProject('p').items.filter(node => result.nodeIds.includes(node.id));
    assert.equal(nodes.length, 3);
    assert.ok(nodes.every(node => expandGenerationPrompts({}, node.config).length === 1));
});

test('completed raw runs with plan=null resolve repeated source IDs by consumed result filePath', async () => {
    const h = harness();
    h.run.plan = null;
    const extra = clone(h.run.steps[0]);
    extra.id = 'second-g1-generation';
    extra.prompt = 'Second variant';
    extra.result = { nodeIds: ['output-variant-2'], filePaths: ['C:/results/variant-2.png'], sourceNodeId: 'g1' };
    h.run.steps.splice(1, 0, extra);
    h.run.results.push({ stepId: extra.id, ...clone(extra.result) });
    // Runtime stores results both on steps and in run.results; either is sufficient.
    delete extra.result;
    h.run.steps[2].references[0].filePath = 'C:/results/variant-2.png';
    const { workflow } = await save(h);
    assert.deepEqual(workflow.steps[2].references[0], { stepId: 'step-2' });
    assert.equal(workflow.inputSlots.length, 2);
    assert.ok(!JSON.stringify(workflow).includes('C:/results/variant-2.png'));
    const result = await h.service.workflowInstantiate('p', { skillId: workflow.id, referenceNodeIds: ['b', 'a'] });
    const connections = h.board.readProject('p').connections.filter(edge => edge.to.nodeId === result.nodeIds[2]);
    assert.deepEqual(connections.map(edge => edge.from.nodeId), [result.nodeIds[1], 'b']);
});

test('unknown tools, duplicate references, missing inputs and forward dependencies reject on save', async () => {
    for (const [mutate, error] of [
        [run => { run.steps[0].tool = 'shell.exec'; }, 'TOOL_NOT_ALLOWED'],
        [run => { run.steps[0].references.push(clone(run.steps[0].references[0])); }, 'INVALID_WORKFLOW'],
        [run => { run.steps[0].references[0].nodeId = 'foreign'; }, 'NODE_NOT_FOUND'],
        [run => { run.steps[0].references[0].nodeId = 'g2'; }, 'INVALID_WORKFLOW']
    ]) {
        const h = harness(); mutate(h.run);
        await assert.rejects(save(h), code(error));
        assert.equal(h.writes, 0);
    }
});

test('instantiate uses one atomic transaction, actual graph ports, idle nodes and one confirmation', async () => {
    const h = harness();
    const { workflow } = await save(h);
    const before = h.board.readProject('p');
    const writes = h.writes;
    const result = await h.service.workflowInstantiate('p', { skillId: workflow.id, referenceNodeIds: ['b', 'a'] });
    assert.equal(h.writes, writes + 1);
    assert.equal(h.transactions.length, 1);
    assert.equal(h.transactions[0].baseRevision, before.revision);
    assert.equal(h.transactions[0].operations.filter(entry => entry.op === 'node.create').length, 2);
    assert.ok(h.transactions[0].operations.filter(entry => entry.op === 'node.create').every(entry => entry.tempId && !entry.item.id));
    const project = h.board.readProject('p');
    assert.equal(project.revision, before.revision + 1);
    assert.deepEqual(project.items.slice(0, before.items.length), before.items);
    const nodes = result.nodeIds.map(id => project.items.find(node => node.id === id));
    assert.ok(nodes.every(node => node.kind === 'op' && node.runStatus === 'idle' && !node.filePath));
    for (const edge of project.connections) {
        const source = project.items.find(node => node.id === edge.from.nodeId);
        assert.ok(getPorts(source).outputs.some(port => port.name === edge.from.port));
        assert.equal(edge.to.port, 'source');
    }
    assert.deepEqual(project.connections.filter(edge => edge.to.nodeId === result.nodeIds[1]).map(edge => edge.from.nodeId),
        [result.nodeIds[0], 'b']);
    assert.equal(Boolean(topoOrder(result.nodeIds[1], project.items, project.connections).cyclic), false);
    assert.deepEqual(result.nextAction, { tool: 'flow_canvas.graph.run',
        arguments: { projectId: 'p', nodeIds: result.nodeIds, summary: `执行流程 ${workflow.name}` }, requiresConfirmation: true });
    await h.board.undo('p', result.undoToken);
    assert.deepEqual(h.board.readProject('p').items, before.items);
    assert.deepEqual(h.board.readProject('p').agentWorkflows, before.agentWorkflows);
});

test('new instructions append explicit user changes after base and reusable context without mutating recipe', async () => {
    const h = harness();
    const { workflow } = await h.service.workflowSave('p', { runId: h.run.id, name: 'Motion', instruction: 'Keep identities' });
    const result = await h.service.workflowInstantiate('p', { skillId: workflow.id, referenceNodeIds: ['b', 'a'],
        instruction: 'Change lighting to daylight' });
    const nodes = h.board.readProject('p').items.filter(node => result.nodeIds.includes(node.id));
    for (const [index, node] of nodes.entries()) {
        assert.equal(node.config.prompt, `${h.run.steps[index].prompt}\n\nWorkflow instruction:\nKeep identities\n\nUser change:\nChange lighting to daylight`);
        assert.equal(expandGenerationPrompts({}, node.config)[0], node.config.prompt);
        assert.equal(node.config.agentCompiledPrompt, undefined);
        assert.equal(node.config.providerId, undefined);
    }
    assert.deepEqual(h.service.workflowList('p').workflows[0], workflow);
});

test('instantiation validates slot count, distinctness, existence and kind without partial writes', async () => {
    const h = harness();
    const { workflow } = await save(h);
    const before = h.data;
    for (const [referenceNodeIds, error] of [[[], 'INVALID_ARGUMENTS'], [['a'], 'INVALID_ARGUMENTS'],
        [['a', 'b', 'c'], 'INVALID_ARGUMENTS'], [['a', 'a'], 'INVALID_ARGUMENTS'],
        [['a', 'missing'], 'NODE_NOT_FOUND'], [['foreign', 'a'], 'NODE_NOT_FOUND'],
        [['output-2', 'a'], 'REFERENCE_TYPE_MISMATCH']]) {
        await assert.rejects(h.service.workflowInstantiate('p', { skillId: workflow.id, referenceNodeIds }), code(error));
        assert.deepEqual(h.data, before);
    }
    assert.equal(h.transactions.length, 0);
});

test('unreferenced text-to-image workflows instantiate with zero input slots', async () => {
    const h = harness();
    h.run.steps = [h.run.steps[0]];
    h.run.steps[0].references = [];
    const { workflow } = await save(h);
    assert.deepEqual(workflow.inputSlots, []);
    const result = await h.service.workflowInstantiate('p', { skillId: workflow.id, referenceNodeIds: [] });
    assert.equal(result.nodeIds.length, 1);
    assert.equal(h.board.readProject('p').connections.length, 0);
});

test('op reference ports use image/video, media uses out, and incompatible ports reject before apply', async () => {
    const h = harness();
    h.run.steps[0].references[0].nodeId = 'output-1';
    await h.board.updateProject('p', project => {
        project.items.find(node => node.id === 'output-1').kind = 'op';
        project.items.find(node => node.id === 'output-1').nodeType = 'image';
    });
    const { workflow } = await save(h);
    const result = await h.service.workflowInstantiate('p', { skillId: workflow.id,
        referenceNodeIds: ['output-1', 'a', 'b'] });
    const edge = h.board.readProject('p').connections.find(entry => entry.to.nodeId === result.nodeIds[0]);
    assert.equal(edge.from.port, 'image');
    const other = harness();
    other.run.steps[0].references[0].nodeId = 'output-2';
    const saved = await save(other);
    await assert.rejects(other.service.workflowInstantiate('p', { skillId: saved.workflow.id,
        referenceNodeIds: ['output-2', 'a', 'b'] }), code('REFERENCE_TYPE_MISMATCH'));
    assert.equal(other.transactions.length, 0);
});

test('stale instantiate transaction conflicts instead of committing against newer edits', async () => {
    const h = harness();
    const { workflow } = await save(h);
    const edit = h.board.updateProject('p', project => { project.items[0].title = 'Concurrent user edit'; });
    const instantiate = h.service.workflowInstantiate('p', { skillId: workflow.id, referenceNodeIds: ['b', 'a'] });
    await edit;
    await assert.rejects(instantiate, code('REVISION_CONFLICT'));
    assert.equal(h.board.readProject('p').items.length, 7);
    assert.equal(h.board.readProject('p').items[0].title, 'Concurrent user edit');
});

test('each explicit instantiation makes fresh node IDs, while replay of its transaction is idempotent', async () => {
    const h = harness();
    const { workflow } = await save(h);
    const first = await h.service.workflowInstantiate('p', { skillId: workflow.id, referenceNodeIds: ['b', 'a'] });
    const writes = h.writes;
    const replay = await h.board.apply('p', h.transactions[0]);
    assert.equal(replay.duplicate, true);
    assert.equal(h.writes, writes);
    const second = await h.service.workflowInstantiate('p', { skillId: workflow.id, referenceNodeIds: ['b', 'a'] });
    assert.equal(first.nodeIds.some(id => second.nodeIds.includes(id)), false);
});

test('persisted recipes are revalidated and unsafe config extensions cannot propagate into nodes', async () => {
    const h = harness();
    const { workflow } = await save(h);
    await h.board.updateProject('p', project => {
        Object.assign(project.agentWorkflows[0].steps[0].config, { apiKey: 'unsafe', providerId: 'private-id',
            agentCompiledPrompt: 'Override', nested: { url: 'https://unsafe.test' } });
    });
    const result = await h.service.workflowInstantiate('p', { skillId: workflow.id, referenceNodeIds: ['b', 'a'] });
    const config = h.board.readProject('p').items.find(node => node.id === result.nodeIds[0]).config;
    assert.equal(config.apiKey, undefined);
    assert.equal(config.providerId, undefined);
    assert.equal(config.agentCompiledPrompt, undefined);
    await h.board.updateProject('p', project => { project.agentWorkflows[0].steps[1].tool = 'shell.exec'; });
    const before = h.data;
    await assert.rejects(h.service.workflowInstantiate('p', { skillId: workflow.id, referenceNodeIds: ['b', 'a'] }), code('INVALID_WORKFLOW'));
    assert.deepEqual(h.data, before);
});

test('write failures propagate and never return phantom documents or workflow nodes', async () => {
    const h = harness();
    h.rejectSave();
    await assert.rejects(create(h), code('SAVE_FAILED'));
    await assert.rejects(save(h), code('SAVE_FAILED'));
    assert.equal(h.writes, 0);
    const other = harness();
    const { workflow } = await save(other);
    const before = other.data;
    other.rejectSave();
    await assert.rejects(other.service.workflowInstantiate('p', { skillId: workflow.id, referenceNodeIds: ['b', 'a'] }), code('SAVE_FAILED'));
    assert.deepEqual(other.data, before);
});

test('workflow reads are detached and scoped, and async getRun is supported', async () => {
    const h = harness();
    h.service.getRun = async () => clone(h.run);
    const { workflow } = await save(h);
    h.service.workflowList('p').workflows[0].steps[0].config.prompt = 'External mutation';
    assert.equal(h.service.workflowList('p').workflows[0].steps[0].config.prompt, workflow.steps[0].config.prompt);
    assert.deepEqual(h.service.workflowList('other').workflows, []);
    await assert.rejects(h.service.workflowInstantiate('other', { skillId: workflow.id, referenceNodeIds: ['foreign'] }), code('WORKFLOW_NOT_FOUND'));
});

test('optional blank instructions leave the exact configured base prompts unchanged', async () => {
    const h = harness();
    const { workflow } = await h.service.workflowSave('p', { runId: h.run.id, name: 'No additions', instruction: '' });
    const result = await h.service.workflowInstantiate('p', { skillId: workflow.id, referenceNodeIds: ['b', 'a'], instruction: '  ' });
    const project = h.board.readProject('p');
    result.nodeIds.forEach((id, index) => {
        assert.equal(project.items.find(node => node.id === id).config.prompt, h.run.steps[index].prompt);
    });
});

test('malformed completed steps and duplicate persisted slot IDs produce domain errors', async () => {
    const h = harness();
    h.run.steps[0] = null;
    await assert.rejects(save(h), code('INVALID_WORKFLOW'));
    const other = harness();
    const { workflow } = await save(other);
    await other.board.updateProject('p', project => {
        project.agentWorkflows[0].inputSlots[1].id = project.agentWorkflows[0].inputSlots[0].id;
    });
    await assert.rejects(other.service.workflowInstantiate('p', { skillId: workflow.id, referenceNodeIds: ['b', 'a'] }), code('INVALID_WORKFLOW'));
    assert.equal(other.transactions.length, 0);
});

test('legacy plan IDs that match object prototype keys still report the table template', async () => {
    const h = harness();
    await create(h);
    await h.board.updateProject('p', project => { project.plans[0].id = 'constructor'; });
    assert.equal(h.service.documentList('p').documents[0].templateId, 'table');
    assert.equal(h.service.documentGet('p', { documentId: 'constructor' }).document.templateId, 'table');
});
