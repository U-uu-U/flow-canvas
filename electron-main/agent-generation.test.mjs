import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { AgentGeneration } from './agent-generation.mjs';
import { AgentMedia } from './agent-media.cjs';

const copy = value => structuredClone(value);
const op = (id, nodeType = 'image', config = {}) => ({
    id, kind: 'op', nodeType, title: id, x: 10, y: 20, width: 320, height: 240,
    config: { ...(nodeType === 'text' ? {} : { prompt: `prompt-${id}`, count: 1 }), ...config }
});
const edge = (from, to, kind) => ({ id: `${from}-${to}`, from: { nodeId: from, port: 'out' }, to: { nodeId: to, port: 'in' }, ...(kind ? { kind } : {}) });
const provider = (id, kind, model) => ({ id, capability: kind, model, models: [model], apiKey: 'mock-key', endpoint: 'https://example.invalid/v1' });

async function setup(t, { items = [op('image')], connections = [], providers } = {}) {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'agent-generation-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const projects = {
        original: { projectId: 'original', items: copy(items), connections: copy(connections), plans: [], revision: 0,
            folders: [directory], defaultSaveFolder: directory },
        other: { projectId: 'other', items: [op('untouched')], connections: [], folders: [], plans: [], revision: 7 }
    };
    const mutations = [], requests = [], checkpoints = [];
    const config = {
        providers: providers || [provider('images', 'image', 'gpt-image-2'), provider('videos', 'video', 'sd2.5')],
        globalConfig: { imageProviderId: 'images', videoProviderId: 'videos' }
    };
    const board = {
        activeProjectId: 'other',
        readProject(id) { assert.ok(projects[id], `Unknown project ${id}`); return copy(projects[id]); },
        async updateProject(id, mutator) {
            const draft = copy(projects[id]);
            await mutator(draft);
            draft.revision++;
            projects[id] = draft;
            mutations.push(id);
            return copy(draft);
        }
    };
    async function file(name, bytes = `mock-${name}`) {
        const filePath = path.join(directory, name);
        await fs.writeFile(filePath, bytes);
        return filePath;
    }
    async function generate(kind, body, requestKind = kind) {
        requests.push({ kind: requestKind, body: copy(body) });
        const filePath = await file(`output-${requests.length}.${kind === 'video' ? 'mp4' : 'png'}`);
        return { filePath, mediaType: kind, taskId: body.taskId || `remote-${requests.length}` };
    }
    const bridge = {
        generateImageFromRenderer: body => generate('image', body),
        generateVideoFromRenderer: body => generate('video', body),
        resumeVideoFromRenderer: body => generate('video', body, 'resume-video'),
        resumeImageFromRenderer: body => generate('image', body, 'resume-image'),
        cancelGenerationFromRenderer: id => requests.push({ kind: 'cancel', id })
    };
    const generation = new AgentGeneration({ board, bridge, loadConfig: () => copy(config), fallbackDir: directory });
    function plan(nodeIds = ['image'], source) {
        const run = { id: 'run-1', projectId: 'original', source, steps: [] };
        const prepared = generation.prepare(run, { nodeIds, summary: 'Approved batch' });
        run.plan = { ...prepared, approved: true };
        run.steps = prepared.steps;
        return run;
    }
    async function execute(step, run, options = {}) {
        return generation.execute(step, run, { checkpoint: patch => {
            checkpoints.push(copy(patch));
            Object.assign(step, patch);
        }, ...options });
    }
    return { directory, projects, board, bridge, config, generation, requests, mutations, checkpoints, file, plan, execute };
}

describe('AgentGeneration planning', () => {
    test('topological generation order deduplicates shared ancestors and ignores history edges', async t => {
        const h = await setup(t, { items: [op('a'), op('b'), op('c')],
            connections: [edge('a', 'b'), edge('a', 'c'), edge('c', 'a', 'history')] });
        const before = copy(h.projects);
        const run = h.plan(['b', 'c', 'b']);
        assert.deepEqual(run.steps.map(step => step.nodeId), ['a', 'b', 'c']);
        assert.deepEqual(h.projects, before);
        assert.equal(h.requests.length, 0);
        assert.equal(h.mutations.length, 0);
    });

    test('reuses an existing untargeted generator output without submitting it again', async t => {
        const h = await setup(t, { items: [op('a'), op('b')], connections: [edge('a', 'b')] });
        const cached = await h.file('cached.png');
        h.projects.original.items[0].resultEntries = [{ filePath: cached }];
        const run = h.plan(['b']);
        assert.deepEqual(run.steps.map(step => step.nodeId), ['b']);
        assert.equal(run.steps[0].references[0].filePath, cached);
        await h.execute(run.steps[0], run);
        assert.equal(h.requests.length, 1);
        assert.equal(h.requests[0].body.sourceReferences[0].filePath, cached);
    });

    test('text graph composition preserves prompt merge modes and batch expansion order', async t => {
        const h = await setup(t, { items: [op('first', 'text', { text: 'FIRST' }), op('second', 'text', { text: 'SECOND' }),
            op('image', 'image', { prompt: 'LOCAL', count: 2, promptMergeMode: 'append' })],
        connections: [edge('second', 'image'), edge('first', 'image')] });
        assert.deepEqual(h.plan().steps.map(step => step.prompt), ['LOCAL\n\nSECOND', 'LOCAL\n\nSECOND', 'LOCAL\n\nFIRST', 'LOCAL\n\nFIRST']);
        h.projects.original.items[2].config.promptMergeMode = 'prepend';
        assert.equal(h.plan().steps[0].prompt, 'SECOND\n\nLOCAL');
        h.projects.original.items[2].config.promptMergeMode = 'replace';
        assert.deepEqual(h.plan().steps.map(step => step.prompt), ['SECOND', 'SECOND', 'FIRST', 'FIRST']);
    });

    test('compiled prompts suppress re-appending upstream text and source overrides stay local', async t => {
        const h = await setup(t, { items: [op('text', 'text', { text: 'UPSTREAM' }), op('image')], connections: [edge('text', 'image')] });
        const before = copy(h.projects.original.items[1]);
        const run = h.plan(['image'], { nodeId: 'image', parameters: { agentCompiledPrompt: 'COMPILED', count: 2 } });
        assert.deepEqual(run.steps.map(step => step.prompt), ['COMPILED', 'COMPILED']);
        assert.deepEqual(h.projects.original.items[1], before);
    });

    test('reference order follows connection order, excluding text and history provenance', async t => {
        const h = await setup(t);
        const first = await h.file('first.png'), second = await h.file('second.png');
        h.projects.original.items.push(
            { id: 'first', kind: 'media', mediaType: 'image', filePath: first },
            { id: 'second', kind: 'media', mediaType: 'image', filePath: second },
            op('text', 'text', { text: 'INSTRUCTION' }), op('history'));
        h.projects.original.connections = [edge('second', 'image'), edge('text', 'image'), edge('first', 'image'), edge('history', 'image', 'history')];
        const run = h.plan();
        assert.deepEqual(run.steps[0].references.map(ref => ref.nodeId), ['second', 'first']);
        assert.ok(run.steps[0].references.every(ref => ref.fileFingerprint));
        await h.execute(run.steps[0], run);
        assert.deepEqual(h.requests[0].body.sourceReferences.map(ref => ref.filePath), [second, first]);
    });

    test('invalid targets, cycles, missing dependencies and implicit text AI are rejected before writes', async t => {
        const h = await setup(t);
        assert.throws(() => h.plan([]), { code: 'INVALID_ARGUMENTS' });
        assert.throws(() => h.plan(Array(21).fill('image')), { code: 'INVALID_ARGUMENTS' });
        assert.throws(() => h.plan(['missing']), { code: 'INVALID_GRAPH' });
        h.projects.original.connections = [edge('missing', 'image')];
        assert.throws(() => h.plan(), { code: 'INVALID_GRAPH' });
        h.projects.original.items.push(op('other'));
        h.projects.original.connections = [edge('other', 'image'), edge('image', 'other')];
        assert.throws(() => h.plan(), { code: 'INVALID_GRAPH' });
        h.projects.original.items = [op('image'), op('text', 'text', { text: 'hello', useAI: true })];
        h.projects.original.connections = [edge('text', 'image')];
        assert.throws(() => h.plan(), { code: 'TEXT_AI_NOT_PLANNED' });
        assert.equal(h.requests.length, 0);
        assert.equal(h.mutations.length, 0);
    });

    test('per-node prompt expansion and total approved requests are bounded', async t => {
        const h = await setup(t);
        h.projects.original.items[0].config.count = 9;
        assert.throws(() => h.plan(), { code: 'COUNT_LIMIT' });
        h.projects.original.items[0].config.count = 1.5;
        assert.throws(() => h.plan(), { code: 'COUNT_LIMIT' });
        h.projects.original.items = [op('a', 'image', { count: 8 }), op('b', 'image', { count: 8 }), op('c', 'image', { count: 8 })];
        assert.throws(() => h.plan(['a', 'b', 'c']), { code: 'BATCH_LIMIT' });
        h.projects.original.items[2].config.count = 4;
        assert.equal(h.plan(['a', 'b', 'c']).steps.length, 20);
    });

    test('zero count is rejected instead of silently becoming one paid generation', async t => {
        const h = await setup(t, { items: [op('image', 'image', { count: 0 })] });
        assert.throws(() => h.plan(), { code: 'COUNT_LIMIT' });
    });

    test('model binding resolves an explicitly selected secondary model', async t => {
        const imageProvider = { ...provider('images', 'image', 'gpt-image-1'), models: ['gpt-image-1', 'gpt-image-2'] };
        const h = await setup(t, { providers: [imageProvider], items: [op('image', 'image', { providerId: 'images', model: 'gpt-image-2' })] });
        assert.equal(h.plan().steps[0].providerRef.id, 'images::model:gpt-image-2');
        assert.equal(h.generation.listModels().length, 2);
        h.config.providers[0].apiKey = '';
        assert.throws(() => h.plan(), { code: 'PROVIDER_REQUIRED' });
    });

    test('video parameters enforce supported durations, ratios, resolutions and optional features', async t => {
        const h = await setup(t, { items: [op('video', 'video')] });
        for (const [field, value, code] of [
            ['duration', 5, 'INVALID_DURATION'], ['resolution', '1080p', 'INVALID_RESOLUTION'],
            ['ratio', '21:9', 'INVALID_RATIO'], ['webSearch', true, 'UNSUPPORTED_PARAMETER'],
            ['watermark', true, 'UNSUPPORTED_PARAMETER'], ['cameraFixed', true, 'UNSUPPORTED_PARAMETER'],
            ['generateAudio', true, 'UNSUPPORTED_PARAMETER']
        ]) {
            h.projects.original.items[0].config = { prompt: 'VIDEO', [field]: value };
            assert.throws(() => h.plan(['video']), { code });
        }
        h.projects.original.items[0].config = { prompt: 'VIDEO' };
        const step = h.plan(['video']).steps[0];
        assert.equal(step.config.duration, 30);
        assert.equal(step.config.resolution, '720p');
        assert.equal(step.config.ratio, 'adaptive');
    });

    test('video reference limits reject excess images and unsupported media types', async t => {
        const h = await setup(t, { items: [op('video', 'video')] });
        const filePath = await h.file('reference.png');
        for (let i = 0; i < 10; i++) {
            h.projects.original.items.push({ id: `ref-${i}`, kind: 'media', mediaType: 'image', filePath });
            h.projects.original.connections.push(edge(`ref-${i}`, 'video'));
        }
        assert.throws(() => h.plan(['video']), { code: 'REFERENCE_LIMIT' });
        h.projects.original.connections.pop();
        assert.equal(h.plan(['video']).steps[0].references.length, 9);
        h.projects.original.items[1].mediaType = 'audio';
        assert.throws(() => h.plan(['video']), { code: 'REFERENCE_LIMIT' });
    });

    test('known request prices are multiplied by the exact approved count', async t => {
        const video = { ...provider('videos', 'video', 'sd2.5'), endpoint: 'https://art.ravenhash.org/v1' };
        const h = await setup(t, { providers: [video], items: [op('video', 'video', { count: 3 })] });
        const run = h.plan(['video']);
        assert.equal(run.plan.priceKnown, true);
        assert.equal(run.plan.estimatedCost, 18);
        assert.equal(run.plan.currency, 'CNY');
        h.config.providers[0].endpoint = 'https://example.invalid/v1';
        assert.equal(h.plan(['video']).plan.estimatedCost, null);
    });

    test('known video models without a resolution selector accept their default parameters', async t => {
        for (const model of ['kling', 'vidu']) {
            const h = await setup(t, { providers: [provider('videos', 'video', model)], items: [op('video', 'video')] });
            assert.doesNotThrow(() => h.plan(['video']));
        }
    });
});

describe('AgentGeneration execution', () => {
    test('a downloaded checkpoint lands its saved output without a second provider call', async t => {
        const h = await setup(t);
        const run = h.plan();
        run.steps[0].filePaths = [await h.file('already-downloaded.png')];
        const result = await h.execute(run.steps[0], run);
        assert.equal(h.requests.length, 0);
        assert.equal(result.filePaths[0], run.steps[0].filePaths[0]);
        assert.ok(h.projects.original.items.find(node => node.id === result.nodeIds[0]).filePath);
    });
    test('source graph/config/file changes invalidate approval before any submission', async t => {
        for (const mode of ['config', 'connection', 'removed', 'file']) {
            const h = await setup(t);
            const filePath = await h.file('source.png');
            h.projects.original.items.push({ id: 'source', kind: 'media', mediaType: 'image', filePath });
            h.projects.original.connections = [edge('source', 'image')];
            const run = h.plan();
            if (mode === 'config') h.projects.original.items[0].config.prompt = 'changed';
            if (mode === 'connection') h.projects.original.connections[0].to.port = 'changed';
            if (mode === 'removed') h.projects.original.items.pop();
            if (mode === 'file') await fs.writeFile(filePath, 'different-and-longer-source-content');
            await assert.rejects(h.execute(run.steps[0], run), { code: 'SOURCE_CHANGED' });
            assert.equal(h.requests.length, 0);
            assert.equal(h.mutations.length, 0);
        }
    });

    test('late results are saved to the original project without any renderer dependency', async t => {
        const h = await setup(t);
        const untouched = copy(h.projects.other);
        const original = copy(h.projects.original.items[0]);
        const run = h.plan();
        h.bridge.generateImageFromRenderer = async body => {
            assert.equal(body.addToCanvas, false);
            assert.ok(body.targetDir.startsWith(h.directory));
            h.board.activeProjectId = 'other';
            return { filePath: await h.file('late.png'), mediaType: 'image' };
        };
        const result = await h.execute(run.steps[0], run);
        assert.equal(result.nodeIds[0], `result-${run.steps[0].id}`);
        assert.deepEqual(h.mutations, ['original', 'original']);
        assert.deepEqual(h.projects.other, untouched);
        assert.deepEqual(h.projects.original.items[0], original);
        const output = h.projects.original.items[1];
        assert.equal(output.runStatus, 'done');
        assert.equal(output.generation.agentRunId, run.id);
        assert.equal(output.resultEntries[0].filePath, result.filePaths[0]);
        assert.equal(h.projects.original.connections[0].kind, 'history');
    });

    test('approved count loop submits each step once and preserves every result reference', async t => {
        const h = await setup(t, { items: [op('image', 'image', { count: 3 })] });
        const run = h.plan();
        const outputs = [];
        for (const step of run.steps) outputs.push(await h.execute(step, run));
        assert.equal(h.requests.length, run.plan.steps.length);
        assert.equal(h.requests.length, 3);
        assert.equal(new Set(h.requests.map(request => request.body.clientTaskId)).size, 3);
        assert.equal(h.projects.original.items.length, 4);
        assert.equal(h.projects.original.connections.length, 3);
        for (const [i, output] of outputs.entries()) {
            const node = h.projects.original.items.find(item => item.id === output.nodeIds[0]);
            assert.equal(node.config.count, 1);
            assert.equal(node.generation.prompt, run.steps[i].prompt);
            assert.deepEqual(node.resultEntries.map(entry => entry.filePath), output.filePaths);
        }
        for (const step of run.steps) assert.equal((await h.execute(step, run)).reused, true);
        assert.equal(h.requests.length, 3);
    });

    test('new upstream results are passed to the dependent step without extra requests', async t => {
        const h = await setup(t, { items: [op('a'), op('b')], connections: [edge('a', 'b')] });
        const run = h.plan(['b']);
        const upstream = await h.execute(run.steps[0], run);
        assert.equal(run.steps[1].references[0].filePath, upstream.filePaths[0]);
        const downstream = await h.execute(run.steps[1], run);
        assert.equal(h.requests.length, 2);
        assert.equal(h.requests[1].body.sourceReferences[0].filePath, upstream.filePaths[0]);
        const output = h.projects.original.items.find(item => item.id === downstream.nodeIds[0]);
        assert.deepEqual(output.generation.references, [{ itemId: 'a', filePath: upstream.filePaths[0] }]);
    });

    test('explicitly regenerated upstream replaces its cached result in downstream references', async t => {
        const h = await setup(t, { items: [op('a'), op('b')], connections: [edge('a', 'b')] });
        const cached = await h.file('old-result.png');
        h.projects.original.items[0].resultEntries = [{ filePath: cached }];
        const run = h.plan(['a', 'b']);
        const fresh = await h.execute(run.steps[0], run);
        await h.execute(run.steps[1], run);
        assert.equal(h.requests[1].body.sourceReferences[0].filePath, fresh.filePaths[0]);
    });

    test('switching a reused generator result after approval invalidates the source', async t => {
        const h = await setup(t, { items: [op('a'), op('b')], connections: [edge('a', 'b')] });
        h.projects.original.items[0].resultEntries = [{ filePath: await h.file('first.png') }];
        const run = h.plan(['b']);
        h.projects.original.items[0].resultEntries = [{ filePath: await h.file('second.png') }];
        await assert.rejects(h.execute(run.steps[0], run), { code: 'SOURCE_CHANGED' });
        assert.equal(h.requests.length, 0);
    });

    test('late source changes preserve downloaded files without writing a completed result', async t => {
        const h = await setup(t);
        const run = h.plan();
        const filePath = await h.file('late-result.png');
        h.bridge.generateImageFromRenderer = async () => {
            h.projects.original.items[0].config.prompt = 'edited-during-provider-call';
            return { filePath };
        };
        await assert.rejects(h.execute(run.steps[0], run), { code: 'SOURCE_CHANGED' });
        assert.equal(await fs.readFile(filePath, 'utf8'), 'mock-late-result.png');
        assert.equal(h.projects.original.items[1].filePath, undefined);
        assert.equal(h.checkpoints.at(-1).status, 'downloaded');
    });

    test('cancel during provider wait signals the bridge and never publishes late output', async t => {
        const h = await setup(t);
        const run = h.plan();
        const controller = new AbortController();
        const filePath = await h.file('cancelled.png');
        h.bridge.generateImageFromRenderer = async () => { controller.abort(); return { filePath }; };
        await assert.rejects(h.execute(run.steps[0], run, { signal: controller.signal }), { code: 'CANCELED' });
        assert.deepEqual(h.requests, [{ kind: 'cancel', id: run.steps[0].id }]);
        assert.equal(h.projects.original.items[1].filePath, undefined);
        assert.equal(await fs.readFile(filePath, 'utf8'), 'mock-cancelled.png');
    });

    test('video and image resume poll approved remote tasks without resubmitting', async t => {
        const h = await setup(t, { items: [op('video', 'video'), op('image')] });
        const run = h.plan(['video']);
        run.steps[0].remoteTaskId = 'approved-remote';
        await h.execute(run.steps[0], run, { resume: true });
        assert.equal(h.requests[0].kind, 'resume-video');
        assert.equal(h.requests[0].body.taskId, 'approved-remote');
        const imageRun = h.plan(['image']);
        imageRun.steps[0].remoteTaskId = 'image-remote';
        const imageResult = await h.execute(imageRun.steps[0], imageRun, { resume: true });
        assert.deepEqual(h.requests.map(request => request.kind), ['resume-video', 'resume-image']);
        assert.equal(h.requests[1].body.taskId, 'image-remote');
        assert.equal(h.requests[1].body.clientTaskId, imageRun.steps[0].id);
        assert.equal(h.requests[1].body.addToCanvas, false);
        assert.ok(h.checkpoints.every(checkpoint => checkpoint.status === 'downloaded'));
        const output = h.projects.original.items.find(item => item.id === imageResult.nodeIds[0]);
        assert.equal(output.mediaType, 'image');
        assert.equal(output.runStatus, 'done');
        assert.equal(output.generation.taskId, 'image-remote');
        assert.equal(output.filePath, imageResult.filePaths[0]);
    });
});

describe('AgentMedia isolated previews', () => {
    async function mediaSetup(t, name = 'source.png') {
        const h = await setup(t);
        const filePath = await h.file(name, name.endsWith('.png')
            ? await sharp({ create: { width: 80, height: 40, channels: 3, background: '#e34d61' } }).png().toBuffer()
            : 'mock-media');
        h.projects.original.items = [{ id: 'source', kind: 'media', filePath }];
        const frameCalls = [];
        const frame = `data:image/png;base64,${(await sharp({ create: { width: 2, height: 2, channels: 3, background: '#257c8c' } }).png().toBuffer()).toString('base64')}`;
        const media = new AgentMedia({ board: h.board, directory: path.join(h.directory, 'cache'),
            readFrames: async (...args) => { frameCalls.push(args); return { duration: 10, frames: [{ time: 1, dataUrl: frame }, { time: 7, dataUrl: frame }] }; } });
        return { ...h, media, filePath, frameCalls };
    }

    test('real PNG previews and normalized crops produce inspectable pixels without editing source', async t => {
        const h = await mediaSetup(t);
        const before = await fs.readFile(h.filePath);
        const result = await h.media.read('original', { nodeId: 'source', crop: { x: 0.25, y: 0, width: 0.5, height: 1 } });
        const image = result.images.find(part => part.type === 'image_url');
        const bytes = Buffer.from(image.image_url.url.split(',')[1], 'base64');
        const metadata = await sharp(bytes).metadata();
        assert.equal(metadata.width, 40);
        assert.equal(metadata.height, 40);
        assert.deepEqual(await fs.readFile(h.filePath), before);
        await assert.rejects(h.media.read('original', { nodeId: 'source', crop: { x: 0.9, y: 0, width: 0.5, height: 1 } }));
    });

    test('video frame reader receives time and signal; cached reads do not sample again', async t => {
        const h = await mediaSetup(t, 'source.mp4');
        const controller = new AbortController();
        const result = await h.media.read('original', { nodeId: 'source', time: 3 }, controller.signal);
        assert.equal(h.frameCalls[0][0], await fs.realpath(h.filePath));
        assert.equal(h.frameCalls[0][1], 3);
        assert.equal(h.frameCalls[0][2], controller.signal);
        assert.deepEqual(result.frames, [{ time: 1 }, { time: 7 }]);
        assert.equal(result.images.filter(part => part.type === 'image_url').length, 2);
        const cached = await h.media.read('original', { nodeId: 'source', time: 3 });
        assert.equal(cached.fingerprint, result.fingerprint);
        assert.equal(h.frameCalls.length, 1);
    });

    test('pre-cancelled reads and out-of-project files do not run frame extraction', async t => {
        const h = await mediaSetup(t, 'source.mp4');
        await assert.rejects(h.media.read('original', { nodeId: 'source' }, AbortSignal.abort()));
        h.projects.original.folders = [];
        h.projects.original.defaultSaveFolder = null;
        await assert.rejects(h.media.read('original', { nodeId: 'source' }));
        assert.equal(h.frameCalls.length, 0);
    });

    test('cached visual evidence retains the requested node identity when two nodes share a file', async t => {
        const h = await mediaSetup(t);
        h.projects.original.items.push({ id: 'second', kind: 'media', filePath: h.filePath });
        await h.media.read('original', { nodeId: 'source' });
        const result = await h.media.read('original', { nodeId: 'second' });
        assert.equal(result.nodeId, 'second');
        assert.ok(result.images.find(part => part.type === 'text').text.includes('second'));
    });
});
