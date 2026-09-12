import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentBoardService } from './agent-board-service.mjs';
import { installGenerationNodeLanding } from './generation-node-landing.mjs';
import { generationNodeSignature } from '../shared/generation-node-state.mjs';
import { applyGeneratorStackResult } from '../shared/generation-result-state.mjs';
import { getGeneratorPlaceholderSize } from '../src/generator-placeholder-layout.js';
import { appendGeneratorResult, rotateGeneratorResults } from '../src/generator-result-stack.js';

const clone = value => structuredClone(value);

function setup({ kind = 'image', active = 'original', extraItems = [], connections = [] } = {}) {
    const source = {
        id: 'node', kind: 'op', nodeType: kind, title: 'Original generator',
        config: { prompt: 'original', model: 'model', ratio: '4:3', width: 1024, height: 768 },
        x: 10, y: 20, width: 400, height: 300, runStatus: 'running', runError: 'old error'
    };
    const original = { id: 'original', savedItems: [source, ...clone(extraItems)], connections: clone(connections) };
    const other = { id: 'other', savedItems: [{ id: 'node', kind: 'op', nodeType: 'image', config: { prompt: 'other project' } }], connections: [] };
    const selected = active === 'original' ? original : other;
    let state = { activeGroupId: active, items: clone(selected.savedItems), connections: clone(selected.connections), folderGroups: [original, other] };
    let writes = 0;
    let rejectSave = false;
    const events = [];
    const store = {
        load: () => clone(state),
        save(value) {
            if (rejectSave) return false;
            state = clone(value);
            writes++;
            return true;
        }
    };
    const board = new AgentBoardService({ store, onChange: change => events.push(change) });
    const bridge = {};
    installGenerationNodeLanding(bridge, board);
    return {
        board, bridge, store, events,
        request: { projectId: 'original', nodeId: source.id, expectedNode: clone(source), operationId: 'run-1:0', output: imageOutput('/one.png') },
        get state() { return clone(state); },
        get writes() { return writes; },
        set rejectSave(value) { rejectSave = value; }
    };
}

function imageOutput(filePath, extra = {}) {
    return { image: `local-res://${encodeURIComponent(filePath)}`, _resultFilePath: filePath, ...extra };
}

function sourceNode(h) {
    return h.board.readProject('original').items.find(item => item.id === 'node');
}

function overlaps(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

test('converting a generated image preserves the user display name without changing the saved file path', async () => {
    const h = setup();
    await h.board.updateProject('original', project => { project.items[0].displayName = 'User title'; });
    const result = await h.bridge.landGenerationResult({ ...h.request, expectedNode: sourceNode(h) });
    assert.equal(result.sourceNode.displayName, 'User title');
    assert.equal(result.sourceNode.filePath, '/one.png');
});

for (const kind of ['image', 'video']) {
    test(`${kind} node landing and direct stack application produce the same result state`, async () => {
        const h = setup({ kind, active: 'other' });
        const expected = clone(h.request.expectedNode);
        let expectedNode = clone(expected);
        for (const [index, dimensions] of [[2, [1800, 900]], [4, [900, 1800]]]) {
            const output = {
                _resultFilePath: `/candidate-${index}.png`, _resultUrl: `https://cdn.example/${index}`,
                _preserveGeneratorStack: true, _candidateIndex: index,
                _resultItem: { naturalWidth: dimensions[0], naturalHeight: dimensions[1], candidateIndex: 9 },
                _generation: { nodeType: kind, generatedAt: 123, taskId: 'task', references: [{ filePath: '/reference.png' }] }
            };
            applyGeneratorStackResult(expected, output, { completed: true });
            const result = await h.bridge.landGenerationResult({ ...h.request, output, expectedNode, operationId: `candidate:${index}` });
            assert.deepEqual(result.sourceNode, expected);
            expectedNode = result.sourceNode;
        }
        assert.equal(expected.runError, '');
        assert.deepEqual(expected.resultItems.map(item => item.candidateIndex), [2, 4]);
        assert.equal(h.board.readProject('original').items.length, 1);
    });
}

test('a project switch while generation runs lands only in the original project', async () => {
    const h = setup();
    const incoming = h.state;
    const other = incoming.folderGroups.find(group => group.id === 'other');
    incoming.activeGroupId = 'other';
    incoming.items = clone(other.savedItems);
    incoming.connections = clone(other.connections);
    assert.equal(h.board.mergeRendererSave({ data: incoming, sourceActiveGroupId: 'original', sourceRevisions: { original: 0, other: 0 } }).ok, true);
    const otherBefore = h.board.readProject('other').items;
    const result = await h.bridge.landGenerationResult(h.request);
    assert.equal(result.projectId, 'original');
    assert.equal(result.nodeId, 'node');
    assert.equal(result.resultNodeId, 'node');
    assert.equal(result.duplicate, false);
    assert.deepEqual(result.sourceNode, sourceNode(h));
    assert.equal(result.sourceNode.filePath, '/one.png');
    assert.equal(h.state.activeGroupId, 'other');
    assert.deepEqual(h.state.items, otherBefore);
    assert.deepEqual(h.board.readProject('other').items, otherBefore);
    assert.deepEqual(h.events.at(-1).projectIds, ['original']);
});

test('the first ordinary image replaces the op and converts incoming and outgoing connections', async () => {
    const h = setup({ active: 'other', extraItems: [
        { id: 'ref', kind: 'media', filePath: '/reference.png' },
        { id: 'prompt', kind: 'op', nodeType: 'text', config: { prompt: 'prompt' } },
        { id: 'downstream', kind: 'op', nodeType: 'video' }
    ], connections: [
        { id: 'reference', from: { nodeId: 'ref', port: 'out' }, to: { nodeId: 'node', port: 'reference' } },
        { id: 'prompt', from: { nodeId: 'prompt', port: 'text' }, to: { nodeId: 'node', port: 'prompt' } },
        { id: 'output', from: { nodeId: 'node', port: 'image' }, to: { nodeId: 'downstream', port: 'source' } },
        { id: 'unrelated', kind: 'history', from: { nodeId: 'ref', port: 'out' }, to: { nodeId: 'downstream', port: 'source' } }
    ] });
    h.request.output._resultItem = { id: 'download-id', width: 999, height: 999, naturalWidth: 2048, naturalHeight: 1536, mimeType: 'image/png' };
    const untouchedRequest = clone(h.request);
    const result = await h.bridge.landGenerationResult(h.request);
    const node = result.sourceNode;
    assert.equal(node.id, 'node');
    assert.equal(node.kind, 'media');
    assert.equal(node.nodeType, undefined);
    assert.equal(node.config, undefined);
    assert.equal(node.mediaType, 'image');
    assert.deepEqual([node.x, node.y, node.width, node.height], [10, 20, 400, 300]);
    assert.equal(node.naturalWidth, 2048);
    assert.equal(node.mimeType, 'image/png');
    assert.equal(node.generation.replacedGenerator, true);
    assert.deepEqual(node.generation.config, h.request.expectedNode.config);
    assert.deepEqual(node.generation.references, [{ itemId: 'ref', filePath: '/reference.png' }]);
    assert.equal(node.runStatus, 'done');
    assert.equal(node.runError, '');
    const links = h.board.readProject('original').connections;
    for (const link of links.slice(0, 2)) {
        assert.equal(link.kind, 'history');
        assert.equal(link.to.port, 'source');
    }
    assert.deepEqual(links[2].from, { nodeId: 'node', port: 'out' });
    assert.equal(links[2].kind, undefined);
    assert.deepEqual(links[3], h.state.folderGroups[0].connections[3]);
    assert.deepEqual(h.request, untouchedRequest);
});

test('generation metadata, reference bindings and format survive conversion', async () => {
    const h = setup();
    const generation = {
        nodeType: 'image', prompt: 'expanded prompt', requestPrompt: 'expanded prompt',
        promptDraftConfig: { prompt: 'raw draft', referenceCitationOccurrences: [{ id: 'cite', sourceNodeId: 'ref', offset: 0 }] },
        referenceBindings: [{ position: 1, sourceNodeId: 'ref', filePath: '/ref.png' }],
        config: { prompt: 'raw draft', model: 'mj' }, model: 'mj', providerId: 'provider',
        sourceProviderId: 'source-provider', taskId: 'task-1', generatedAt: 1234,
        references: [{ itemId: 'ref', filePath: '/ref.png' }]
    };
    h.request.output = imageOutput('/animated.mp4', { _resultMediaType: 'video', _generation: generation });
    const { sourceNode: node } = await h.bridge.landGenerationResult(h.request);
    for (const [key, value] of Object.entries(generation)) assert.deepEqual(node.generation[key], value);
    assert.equal(node.mediaType, 'video');
    node.generation.config.prompt = 'caller edit';
    assert.equal(sourceNode(h).generation.config.prompt, 'raw draft');
});

test('four MJ candidates remain one op with a square result stack and distinct candidate indices', async () => {
    const h = setup({ active: 'other' });
    let expectedNode = h.request.expectedNode;
    for (let index = 1; index <= 4; index++) {
        const output = imageOutput(`/mj-${index}.png`, {
            _preserveGeneratorStack: true, _forceSquarePreview: true, _candidateIndex: index,
            _resultItem: index === 1 ? { naturalWidth: 2048, naturalHeight: 1024, filePath: `/mj-${index}.png` } : null,
            _generation: { nodeType: 'image', taskId: 'mj-task', config: clone(expectedNode.config), referenceBindings: [] }
        });
        const result = await h.bridge.landGenerationResult({ ...h.request, expectedNode, output, operationId: `mj:${index}` });
        assert.equal(result.resultNodeId, 'node');
        assert.equal(result.duplicate, false);
        expectedNode = result.sourceNode;
    }
    const project = h.board.readProject('original');
    const node = project.items[0];
    assert.equal(project.items.length, 1);
    assert.equal(project.connections.length, 0);
    assert.equal(node.kind, 'op');
    assert.equal(node.nodeType, 'image');
    assert.equal(node.preserveGeneratorStack, true);
    assert.deepEqual(node.resultFilePaths, ['/mj-1.png', '/mj-2.png', '/mj-3.png', '/mj-4.png']);
    assert.deepEqual(node.resultEntries.map(entry => entry.item.candidateIndex), [1, 2, 3, 4]);
    assert.deepEqual({ width: node.width, height: node.height }, getGeneratorPlaceholderSize('image', { ratio: '1:1' }));
    assert.deepEqual([node.x, node.y], [10, 20]);
    assert.equal(node.generation.taskId, 'mj-task');
    assert.equal(node.runStatus, 'done');
});

test('video results append to the op and retain the first preview dimensions', async () => {
    const h = setup({ kind: 'video' });
    const video = (name, width, height) => ({
        video: `local-res://${encodeURIComponent(name)}`, _resultFilePath: name, _resultUrl: `https://cdn.example/${name}`,
        _resultItem: { filePath: name, mediaType: 'video', naturalWidth: width, naturalHeight: height },
        _generation: { nodeType: 'video', taskId: name, config: { ratio: '16:9', duration: 5 } }
    });
    const first = await h.bridge.landGenerationResult({ ...h.request, output: video('/one.mp4', 1920, 1080) });
    assert.deepEqual({ width: first.sourceNode.width, height: first.sourceNode.height }, getGeneratorPlaceholderSize('video', {}, { width: 1920, height: 1080 }));
    const second = await h.bridge.landGenerationResult({ ...h.request, expectedNode: first.sourceNode, operationId: 'video:2', output: video('/two.mp4', 1080, 1920) });
    assert.equal(second.sourceNode.kind, 'op');
    assert.equal(second.sourceNode.nodeType, 'video');
    assert.deepEqual(second.sourceNode.resultFilePaths, ['/one.mp4', '/two.mp4']);
    assert.equal(second.sourceNode.width, first.sourceNode.width);
    assert.equal(second.sourceNode.height, first.sourceNode.height);
    assert.equal(second.sourceNode.generation.taskId, '/two.mp4');
    assert.equal(h.board.readProject('original').items.length, 1);
});

test('existing video stack entries and display geometry survive another result', async () => {
    const h = setup({ kind: 'video' });
    await h.board.updateProject('original', project => appendGeneratorResult(project.items[0], { filePath: '/old.mp4' }));
    const result = await h.bridge.landGenerationResult({ ...h.request, expectedNode: sourceNode(h), output: { video: '/new.mp4', _resultItem: { naturalWidth: 1, naturalHeight: 2 } } });
    assert.deepEqual(result.sourceNode.resultFilePaths, ['/old.mp4', '/new.mp4']);
    assert.deepEqual([result.sourceNode.width, result.sourceNode.height], [400, 300]);
});

test('two ordinary batch outputs produce original media plus right-side media and a history connection', async () => {
    const h = setup({ extraItems: [
        { id: 'placeholder', kind: 'op', nodeType: 'image', x: 425, y: 0, width: 450, height: 450 },
        { id: 'offset-obstacle', kind: 'media', filePath: '/obstacle.png', x: 460, y: 420, width: 350, height: 350 }
    ] });
    const first = await h.bridge.landGenerationResult(h.request);
    const secondRequest = { ...h.request, expectedNode: first.sourceNode, operationId: 'run-1:1', output: imageOutput('/two.png', { _resultItem: { id: 'placeholder' } }) };
    const second = await h.bridge.landGenerationResult(secondRequest);
    const project = h.board.readProject('original');
    assert.notEqual(second.resultNodeId, first.resultNodeId);
    assert.notEqual(second.resultNodeId, 'placeholder');
    assert.deepEqual(second.sourceNode, first.sourceNode);
    const result = project.items.find(item => item.id === second.resultNodeId);
    assert.equal(result.kind, 'media');
    assert.equal(result.filePath, '/two.png');
    assert.equal(result.fromNodeId, 'node');
    assert.equal(result.x, 450);
    assert.equal(result.y, 810);
    assert.deepEqual([result.width, result.height], [400, 300]);
    for (const item of project.items.filter(item => item.id !== result.id)) assert.equal(overlaps(result, item), false);
    assert.equal(project.connections.length, 1);
    assert.equal(project.connections[0].kind, 'history');
    assert.deepEqual(project.connections[0].from, { nodeId: 'node', port: 'out' });
    assert.deepEqual(project.connections[0].to, { nodeId: result.id, port: 'source' });
    const writes = h.writes;
    const duplicate = await h.bridge.landGenerationResult(secondRequest);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.resultNodeId, second.resultNodeId);
    assert.equal(h.writes, writes);
    assert.equal(h.board.readProject('original').items.length, 4);
});

test('semantic config changes queued before landing reject without overwriting the project', async () => {
    const h = setup();
    const edit = h.board.updateProject('original', project => { project.items[0].config.prompt = 'manual edit'; });
    const landing = h.bridge.landGenerationResult(h.request);
    await edit;
    const before = h.state;
    await assert.rejects(landing, { code: 'SOURCE_CHANGED' });
    assert.deepEqual(h.state, before);
    assert.equal(h.writes, 1);
    assert.equal(sourceNode(h).config.prompt, 'manual edit');
});

test('movement, resize and run status changes are allowed and latest geometry is retained', async () => {
    const h = setup();
    await h.board.updateProject('original', project => Object.assign(project.items[0], { x: -500, y: 880, width: 512, height: 128, runStatus: 'idle', runError: '' }));
    const result = await h.bridge.landGenerationResult(h.request);
    assert.deepEqual([result.sourceNode.x, result.sourceNode.y, result.sourceNode.width, result.sourceNode.height], [-500, 880, 512, 128]);
    assert.equal(result.sourceNode.filePath, '/one.png');
});

test('a repeated operation is durable across service restart and returns the latest source without resetting a stack', async () => {
    const h = setup({ kind: 'video' });
    h.request.output = { video: '/one.mp4' };
    const first = await h.bridge.landGenerationResult(h.request);
    await h.bridge.landGenerationResult({ ...h.request, operationId: 'second', expectedNode: first.sourceNode, output: { video: '/two.mp4' } });
    await h.board.updateProject('original', project => {
        const node = project.items[0];
        rotateGeneratorResults(node);
        node.config.prompt = 'edited after success';
        node.x = 900;
    });
    const current = sourceNode(h);
    const before = h.state;
    const restarted = {};
    installGenerationNodeLanding(restarted, new AgentBoardService({ store: h.store }));
    const result = await restarted.landGenerationResult(h.request);
    assert.equal(result.duplicate, true);
    assert.equal(result.resultNodeId, first.resultNodeId);
    assert.deepEqual(result.sourceNode, current);
    assert.deepEqual(h.state, before);
});

test('simultaneous retries serialize and only commit once', async () => {
    const h = setup();
    const first = h.bridge.landGenerationResult(h.request);
    const retry = h.bridge.landGenerationResult(h.request);
    const result = await first;
    const duplicate = await retry;
    assert.equal(result.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.resultNodeId, result.resultNodeId);
    assert.equal(h.writes, 1);
    assert.equal(h.board.readProject('original').generationNodeLandings.length, 1);
});

test('different operations with a stale image-generator snapshot do not both convert or append', async () => {
    const h = setup();
    const first = h.bridge.landGenerationResult(h.request);
    const stale = h.bridge.landGenerationResult({ ...h.request, operationId: 'another', output: imageOutput('/two.png') });
    await first;
    await assert.rejects(stale, { code: 'SOURCE_CHANGED' });
    assert.equal(h.writes, 1);
    assert.equal(h.board.readProject('original').items.length, 1);
});

test('queued requests capture their arguments before the caller can mutate them', async () => {
    const h = setup();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const earlier = h.board.updateProject('original', () => gate);
    const pending = h.bridge.landGenerationResult(h.request);
    h.request.output._resultFilePath = '/wrong.png';
    h.request.expectedNode.config.prompt = 'mutated caller';
    release();
    await earlier;
    assert.equal((await pending).sourceNode.filePath, '/one.png');
});

test('a failed save leaves no receipt or partial conversion and can be retried', async () => {
    const h = setup();
    const before = h.state;
    h.rejectSave = true;
    await assert.rejects(h.bridge.landGenerationResult(h.request), { code: 'SAVE_FAILED' });
    assert.deepEqual(h.state, before);
    h.rejectSave = false;
    assert.equal((await h.bridge.landGenerationResult(h.request)).duplicate, false);
    assert.equal(h.writes, 1);
});

test('deleted sources and missing projects are never recreated, including on a retry', async () => {
    for (const landed of [false, true]) {
        const h = setup({ active: 'other' });
        if (landed) await h.bridge.landGenerationResult(h.request);
        await h.board.updateProject('original', project => { project.items = []; });
        const before = h.state;
        await assert.rejects(h.bridge.landGenerationResult(h.request), { code: 'SOURCE_CHANGED' });
        await assert.rejects(h.bridge.landGenerationResult({ ...h.request, projectId: 'missing' }), { code: 'PROJECT_NOT_FOUND' });
        assert.deepEqual(h.state, before);
    }
});

test('a deleted batch result stays deleted on a retry', async () => {
    const h = setup();
    const first = await h.bridge.landGenerationResult(h.request);
    const request = { ...h.request, expectedNode: first.sourceNode, operationId: 'batch:2', output: imageOutput('/two.png') };
    const result = await h.bridge.landGenerationResult(request);
    await h.board.updateProject('original', project => { project.items = project.items.filter(item => item.id !== result.resultNodeId); });
    const before = h.state;
    assert.equal((await h.bridge.landGenerationResult(request)).duplicate, true);
    assert.deepEqual(h.state, before);
});

test('empty, remote, relative and batch-envelope outputs are rejected without writes', async () => {
    const h = setup();
    for (const output of [null, {}, { image: '' }, { image: 'https://cdn.example/one.png' },
        { image: 'http://cdn.example/one.png' }, { image: '//cdn.example/one.png' },
        { image: 'data:image/png;base64,AA==' }, { image: 'blob:https://example/id' },
        { _resultFilePath: 'https://cdn.example/one.png' }, { image: 'relative.png' },
        { image: 'local-res://https%3A%2F%2Fcdn.example%2Fone.png' }, { image: 'local-res://%INVALID' },
        { _resultFilePath: 42 }, { image: 'C:relative.png' }, { image: '\\\\server\\remote.png' },
        { ...imageOutput('/one.png'), _batchResults: [imageOutput('/one.png')] }]) {
        await assert.rejects(h.bridge.landGenerationResult({ ...h.request, output }), { code: 'INVALID_OUTPUT' });
    }
    assert.equal(h.writes, 0);
});

test('local-res and absolute Windows paths preserve decoded filenames and original file formats', async () => {
    for (const filePath of ['C:\\outputs\\image one.webp', '/outputs/image%20one.png']) {
        const h = setup();
        const result = await h.bridge.landGenerationResult({ ...h.request, output: { image: `local-res://${encodeURIComponent(filePath)}` } });
        assert.equal(result.sourceNode.filePath, filePath);
    }
});

test('request identifiers and expected source identity are required', async () => {
    const h = setup();
    for (const patch of [{ projectId: '' }, { nodeId: '' }, { operationId: '' }, { expectedNode: null }, { expectedNode: { id: 'wrong' } }]) {
        await assert.rejects(h.bridge.landGenerationResult({ ...h.request, ...patch }), { code: 'INVALID_REQUEST' });
    }
    assert.equal(h.writes, 0);
});

test('generation signatures ignore geometry/status and object key order but retain semantic changes', () => {
    const node = setup().request.expectedNode;
    node.generation = { taskId: 'one', config: { prompt: 'draft' } };
    const signature = generationNodeSignature(node);
    const reordered = {
        ...node, x: 99, y: 88, width: 22, height: 33, runStatus: 'done', runError: '', runStartedAt: 123,
        resultEntries: [], _previewImage: { loaded: true }, _previewToken: 42, generatorUiVersion: 1,
        resultLayoutMode: 'branched'
    };
    reordered.config = Object.fromEntries(Object.entries(node.config).reverse());
    assert.equal(generationNodeSignature(reordered), signature);
    for (const change of [
        value => { value.config.prompt = 'edit'; },
        value => { value.config.width = 2048; },
        value => { value.kind = 'media'; },
        value => { value.nodeType = 'video'; },
        value => { value.filePath = '/replacement.png'; },
        value => { value.generation.taskId = 'two'; },
        value => { value.generation.config.prompt = 'new draft'; },
        value => { value.model = 'new-model'; },
        value => { value.resultEntries = [{ filePath: '/result.png' }]; }
    ]) {
        const edited = clone(node);
        change(edited);
        assert.notEqual(generationNodeSignature(edited), signature);
    }
    assert.equal(generationNodeSignature(undefined), generationNodeSignature(null));
});

test('legacy and normalized result entries have the same signature without mutating their inputs', () => {
    const node = { id: 'node', resultFilePaths: ['/one.png'], resultItems: [{ filePath: '/one.png', width: 300, height: 200, candidateIndex: 1 }] };
    const normalized = { id: 'node', resultEntries: [{ filePath: '/one.png', item: { filePath: '/one.png', x: 5, width: 100, height: 50, runStatus: 'done', candidateIndex: 1 } }] };
    const before = clone(node);
    assert.equal(generationNodeSignature(node), generationNodeSignature(normalized));
    normalized.resultEntries[0].item.candidateIndex = 2;
    assert.notEqual(generationNodeSignature(node), generationNodeSignature(normalized));
    assert.deepEqual(node, before);
});

test('long path-based operation IDs are stored only as digests and retry without another append', async () => {
    const h = setup();
    const first = await h.bridge.landGenerationResult(h.request);
    const filePath = `C:/outputs/${'nested/'.repeat(80)}two.png`;
    const request = {
        ...h.request, expectedNode: first.sourceNode, output: imageOutput(filePath),
        operationId: JSON.stringify(['original', 'node', filePath])
    };
    const second = await h.bridge.landGenerationResult(request);
    const duplicate = await h.bridge.landGenerationResult(request);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.resultNodeId, second.resultNodeId);
    const receipts = h.board.readProject('original').generationNodeLandings;
    assert.equal(receipts.length, 2);
    for (const receipt of receipts) {
        assert.match(receipt.key, /^[a-f0-9]{64}$/);
        assert.deepEqual(Object.keys(receipt).sort(), ['key', 'resultNodeId']);
    }
});

test('offscreen error and cancellation update only status on the original node', async () => {
    for (const status of ['error', 'canceled']) {
        const h = setup({ active: 'other' });
        const before = sourceNode(h);
        const activeBefore = h.state.items;
        const result = await h.bridge.updateGenerationNodeStatus({
            ...h.request, status, error: 'terminal reason', operationId: `status:${status}`
        });
        assert.equal(result.projectId, 'original');
        assert.equal(result.nodeId, 'node');
        assert.equal(result.duplicate, false);
        assert.deepEqual(result.sourceNode, { ...before, runStatus: status, runError: 'terminal reason' });
        assert.deepEqual(h.state.items, activeBefore);
        assert.equal(h.state.activeGroupId, 'other');
        assert.deepEqual(h.events.at(-1).projectIds, ['original']);
    }
});

test('status writes allow moved/resized nodes but reject queued semantic edits', async () => {
    const h = setup({ active: 'other' });
    await h.board.updateProject('original', project => Object.assign(project.items[0], { x: 850, width: 850, runStartedAt: 1200 }));
    const request = { ...h.request, status: 'canceled', error: 'canceled by user' };
    const result = await h.bridge.updateGenerationNodeStatus(request);
    assert.equal(result.sourceNode.x, 850);
    assert.equal(result.sourceNode.width, 850);
    assert.equal(result.sourceNode.runStartedAt, 1200);
    const edit = h.board.updateProject('original', project => { project.items[0].config.prompt = 'manual edit'; });
    const pending = h.bridge.updateGenerationNodeStatus({ ...request, operationId: 'later', status: 'error' });
    await edit;
    const before = h.state;
    await assert.rejects(pending, { code: 'SOURCE_CHANGED' });
    assert.deepEqual(h.state, before);
});

test('status and landing idempotency do not collide; terminal state survives an old retry', async () => {
    const h = setup();
    const first = await h.bridge.landGenerationResult(h.request);
    const request = { ...h.request, expectedNode: first.sourceNode, status: 'error', error: 'batch interrupted' };
    const error = await h.bridge.updateGenerationNodeStatus(request);
    assert.equal(error.duplicate, false);
    assert.equal(error.sourceNode.filePath, '/one.png');
    assert.equal(error.sourceNode.runStatus, 'error');
    const canceled = await h.bridge.updateGenerationNodeStatus({ ...request, status: 'canceled', operationId: 'canceled' });
    const before = h.state;
    const restarted = {};
    installGenerationNodeLanding(restarted, new AgentBoardService({ store: h.store }));
    const duplicate = await restarted.updateGenerationNodeStatus(request);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(duplicate.sourceNode, canceled.sourceNode);
    assert.deepEqual(h.state, before);
    assert.equal(h.board.readProject('original').generationNodeStatusKeys.length, 2);
});

test('status timestamps and cleared errors follow the GraphRunner lifecycle', async () => {
    const h = setup();
    const expectedNode = { ...h.request.expectedNode, runStartedAt: 123456 };
    for (const status of ['queued', 'running', 'done', 'idle']) {
        const result = await h.bridge.updateGenerationNodeStatus({ ...h.request, expectedNode, status, operationId: status });
        assert.equal(result.sourceNode.runStatus, status);
        assert.equal(result.sourceNode.runError, '');
        assert.equal(result.sourceNode.runStartedAt, status === 'idle' ? undefined : 123456);
    }
});

test('status rejects missing nodes/projects and unknown states without recreating anything', async () => {
    const h = setup();
    await assert.rejects(h.bridge.updateGenerationNodeStatus({ ...h.request, status: 'failed' }), { code: 'INVALID_REQUEST' });
    await h.board.updateProject('original', project => { project.items = []; });
    const before = h.state;
    await assert.rejects(h.bridge.updateGenerationNodeStatus({ ...h.request, status: 'error' }), { code: 'SOURCE_CHANGED' });
    await assert.rejects(h.bridge.updateGenerationNodeStatus({ ...h.request, projectId: 'missing', status: 'canceled' }), { code: 'PROJECT_NOT_FOUND' });
    assert.deepEqual(h.state, before);
});

test('failed status persistence is retriable and duplicate status writes share the board FIFO', async () => {
    const h = setup({ active: 'other' });
    const request = { ...h.request, status: 'error', error: 'network failed' };
    const before = h.state;
    h.rejectSave = true;
    await assert.rejects(h.bridge.updateGenerationNodeStatus(request), { code: 'SAVE_FAILED' });
    assert.deepEqual(h.state, before);
    h.rejectSave = false;
    const first = h.bridge.updateGenerationNodeStatus(request);
    const retry = h.bridge.updateGenerationNodeStatus(request);
    assert.equal((await first).duplicate, false);
    assert.equal((await retry).duplicate, true);
    assert.equal(h.writes, 1);
});
