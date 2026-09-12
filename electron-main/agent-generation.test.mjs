import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { AgentGeneration } from './agent-generation.mjs';
import { AgentMedia } from './agent-media.cjs';
import { getGenerationReuseConfig } from '../src/generation-record.js';
import { DEFAULT_MODEL_CONFIG } from '../src/model-config-default.js';
import { imageGenerationRequestParams } from '../src/generation-request-params.js';
import { createAgentServices } from './agent-services.cjs';

const copy = value => structuredClone(value);
const op = (id, nodeType = 'image', config = {}) => ({
    id, kind: 'op', nodeType, title: id, x: 10, y: 20, width: 320, height: 240,
    config: { ...(nodeType === 'text' ? {} : { prompt: `prompt-${id}`, count: 1 }), ...config }
});
const edge = (from, to, kind) => ({ id: `${from}-${to}`, from: { nodeId: from, port: 'out' }, to: { nodeId: to, port: 'in' }, ...(kind ? { kind } : {}) });
const provider = (id, kind, model) => ({ id, capability: kind, model, models: [model], apiKey: 'mock-key', endpoint: 'https://example.invalid/v1' });

async function setup(t, { items = [op('image')], connections = [], providers, modelConfig = DEFAULT_MODEL_CONFIG } = {}) {
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
    const capabilities = { current: copy(modelConfig) };
    const generation = new AgentGeneration({ board, bridge, loadConfig: () => copy(config),
        loadModelConfig: () => copy(capabilities.current), fallbackDir: directory });
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
    return { directory, projects, board, bridge, config, capabilities, generation, requests, mutations, checkpoints, file, plan, execute };
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
        for (let i = 0; i < 10; i++) {
            const filePath = await h.file(`reference-${i}.png`);
            h.projects.original.items.push({ id: `ref-${i}`, kind: 'media', mediaType: 'image', filePath });
            h.projects.original.connections.push(edge(`ref-${i}`, 'video'));
        }
        assert.throws(() => h.plan(['video']), { code: 'REFERENCE_LIMIT' });
        h.projects.original.connections.pop();
        assert.equal(h.plan(['video']).steps[0].references.length, 9);
        h.projects.original.items[1].mediaType = 'audio';
        assert.equal(h.plan(['video']).steps[0].references.length, 9, 'undeclared audio support is not a prohibition');
        for (const model of h.capabilities.current.models.filter(model => model.kind === 'video')) {
            model.capabilities.referenceAudios = { supported: false };
        }
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

    test('unlisted custom models follow the renderer warning-only policy', async t => {
        const h = await setup(t, { providers: [provider('videos', 'video', 'custom-video')],
            items: [op('video', 'video', { duration: 7, resolution: 'custom', webSearch: true })] });
        assert.equal(h.plan(['video']).steps[0].config.duration, 7);
        assert.equal(h.generation.listModels()[0].modelConfig.matched, false);
    });
});

describe('AgentGeneration effective CONFIG', () => {
    const entry = (h, id) => h.capabilities.current.models.find(model => model.id === id);
    const mjProviders = [provider('images', 'image', 'mj_imagine')];
    const videoProviders = [provider('videos', 'video', 'seedance_v2.5')];

    test('MJ lists only CONFIG tiers and never plans a 4K-to-sd downgrade', async t => {
        const h = await setup(t, { providers: mjProviders, items: [op('image', 'image', { resolutionTier: '4K' })] });
        assert.deepEqual(h.generation.listModels()[0].resolutions, ['1K', '2K']);
        assert.throws(() => h.plan(), { code: 'INVALID_RESOLUTION' });
        h.projects.original.items[0].config = { prompt: 'MJ', resolutionTier: '1K', size: '3840x2160' };
        assert.throws(() => h.plan(), { code: 'INVALID_RESOLUTION' });
        assert.equal(h.requests.length, 0);
        assert.equal(h.mutations.length, 0);
    });

    test('MJ uses the shared snapshot and sends matching sd/hd for supported tiers', async t => {
        for (const [resolutionTier, definition] of [['1K', 'sd'], ['2K', 'hd']]) {
            const h = await setup(t, { providers: mjProviders, items: [op('image', 'image', {
                resolutionTier, midjourneyVersion: '8.2', midjourneySpeed: 'turbo', midjourneyStylize: 200, webSearch: true
            })] });
            const run = h.plan();
            await h.execute(run.steps[0], run);
            const body = h.requests[0].body;
            assert.equal(body.midjourney.definition, definition);
            assert.equal(body.webSearch, true);
            assert.deepEqual(body.midjourney, copy(imageGenerationRequestParams({ ...run.steps[0].config, midjourneyRepeat: 1 }, 'mj_imagine').midjourney));
        }
    });

    test('dynamic image tiers affect catalog, prepare, and already-approved steps', async t => {
        const h = await setup(t, { providers: mjProviders, items: [op('image', 'image', { resolutionTier: '2K' })] });
        const run = h.plan();
        entry(h, 'midjourney.mj-imagine').options.resolutionTier = { type: 'tier', values: ['1K'], default: '1K' };
        assert.deepEqual(h.generation.listModels()[0].resolutions, ['1K']);
        assert.throws(() => h.plan(), { code: 'INVALID_RESOLUTION' });
        await assert.rejects(h.execute(run.steps[0], run), { code: 'INVALID_RESOLUTION' });
        assert.equal(h.requests.length, 0);
    });

    test('CONFIG duration changes reject stale plans before any board write or paid request', async t => {
        const h = await setup(t, { providers: videoProviders, items: [op('video', 'video', { duration: 20 })] });
        const run = h.plan(['video']);
        const configEntry = h.capabilities.current.models.find(model => model.match.model.includes('^seedance_v2\\.5$'));
        configEntry.options.duration = { type: 'range', min: 4, max: 10, integer: true, default: 6 };
        assert.deepEqual(h.generation.listModels()[0].durations, [4, 5, 6, 7, 8, 9, 10]);
        assert.throws(() => h.plan(['video']), { code: 'INVALID_DURATION' });
        await assert.rejects(h.execute(run.steps[0], run), { code: 'INVALID_DURATION' });
        assert.equal(h.requests.length, 0);
        assert.equal(h.mutations.length, 0);
    });

    test('CONFIG is reread after asynchronous board preparation and immediately before submission', async t => {
        const h = await setup(t, { providers: videoProviders, items: [op('video', 'video', { duration: 20 })] });
        const run = h.plan(['video']);
        let reads = 0;
        h.generation.refreshModelConfig = async () => {
            reads++;
            const config = copy(h.capabilities.current);
            if (reads > 1) config.models.filter(model => model.kind === 'video').forEach(model => {
                model.options.duration = { type: 'fixed', value: 6 };
            });
            return config;
        };
        await assert.rejects(h.execute(run.steps[0], run), { code: 'INVALID_DURATION' });
        assert.equal(reads, 2);
        assert.equal(h.requests.length, 0);
        assert.ok(h.checkpoints.every(value => value.status !== 'submitting'));
    });

    test('truthy Harness feature values cannot bypass validation of normalized wire booleans', async t => {
        const h = await setup(t, { items: [op('video', 'video', { webSearch: 'true' })] });
        assert.throws(() => h.plan(['video']), { code: 'UNSUPPORTED_PARAMETER' });
        h.projects.original.items[0].config.webSearch = false;
        const run = h.plan(['video']);
        run.steps[0].config.webSearch = 1;
        await assert.rejects(h.execute(run.steps[0], run), { code: 'UNSUPPORTED_PARAMETER' });
        assert.equal(h.requests.length, 0);
    });

    test('new CONFIG values override static profiles without inventing feature restrictions', async t => {
        const h = await setup(t, { providers: [provider('videos', 'video', 'minimax-h3')],
            items: [op('video', 'video', { duration: 6, resolution: '1080p', ratio: '21:9', webSearch: true })] });
        for (const model of h.capabilities.current.models.filter(model => model.kind === 'video')) {
            model.options = { duration: { type: 'fixed', value: 6 }, resolutionTier: { type: 'enum', values: ['1080p'] },
                ratio: { type: 'enum', values: ['21:9'] } };
            model.capabilities = {};
        }
        const run = h.plan(['video']);
        await h.execute(run.steps[0], run);
        assert.equal(h.requests[0].body.duration, 6);
        assert.equal(h.requests[0].body.webSearch, true);
    });

    test('H3 normalization is shared for plans and existing stored steps', async t => {
        for (const [input, output] of [['720p', '768p'], ['2K', '2k']]) {
            const h = await setup(t, { providers: [provider('videos', 'video', 'minimax-h3')],
                items: [op('video', 'video', { resolution: input })] });
            const run = h.plan(['video']);
            assert.equal(run.steps[0].config.resolution, output);
            run.steps[0].config.resolution = input;
            await h.execute(run.steps[0], run);
            assert.equal(h.requests[0].body.resolution, output);
        }
    });

    test('ambiguous routes use the same all-candidates validation policy as the renderer', async t => {
        const h = await setup(t, { providers: [provider('videos', 'video', 'custom-video')],
            items: [op('video', 'video', { duration: 8 })], modelConfig: {
                schemaVersion: 1, revision: 91, models: [4, 8].map(duration => ({ id: `route-${duration}`, kind: 'video',
                    match: { model: ['^custom-video$'] }, options: { duration: { type: 'fixed', value: duration } } }))
            } });
        assert.deepEqual(h.generation.listModels()[0].durations, [4, 8]);
        assert.equal(h.generation.listModels()[0].modelConfig.ambiguous, true);
        assert.equal(h.plan(['video']).steps[0].config.duration, 8);
        h.projects.original.items[0].config.duration = 9;
        assert.throws(() => h.plan(['video']), { code: 'INVALID_DURATION' });
    });

    test('prompt, MJ options, reference byte limits and features use CONFIG validation', async t => {
        const h = await setup(t, { providers: mjProviders });
        const model = entry(h, 'midjourney.mj-imagine');
        model.prompt.maxLength = 3;
        assert.throws(() => h.plan(), { code: 'PROMPT_TOO_LONG' });
        h.projects.original.items[0].config.prompt = 'MJ';
        h.projects.original.items[0].config.midjourneyStylize = 1001;
        assert.throws(() => h.plan(), { code: 'VALUE_OUT_OF_RANGE' });
        delete h.projects.original.items[0].config.midjourneyStylize;
        model.capabilities.webSearch = { supported: false };
        h.projects.original.items[0].config.webSearch = true;
        assert.throws(() => h.plan(), { code: 'UNSUPPORTED_PARAMETER' });
        delete h.projects.original.items[0].config.webSearch;
        const filePath = await h.file('ref.png', '123456');
        h.projects.original.items.push({ id: 'ref', kind: 'media', mediaType: 'image', filePath });
        h.projects.original.connections.push(edge('ref', 'image'));
        model.capabilities.referenceImages = { supported: true, maxBytesPerImage: 5 };
        assert.throws(() => h.plan(), error => error.issues?.[0].code === 'REFERENCE_TOO_LARGE');
    });

    test('duplicate image paths are counted once, as in the actual upload snapshot', async t => {
        const h = await setup(t);
        entry(h, 'ravenhash-image.gpt-image-2').capabilities.referenceImages = { supported: true, max: 1 };
        const filePath = await h.file('ref.png');
        for (const id of ['a', 'b']) {
            h.projects.original.items.push({ id, kind: 'media', mediaType: 'image', filePath });
            h.projects.original.connections.push(edge(id, 'image'));
        }
        const run = h.plan();
        await h.execute(run.steps[0], run);
        assert.equal(h.requests[0].body.sourceReferences.length, 1);
    });

    test('CONFIG reads do not serialize independent paid requests or overwrite concurrency', async t => {
        const h = await setup(t, { items: [op('a', 'image', { concurrency: 3 }), op('b', 'image', { concurrency: 3 })] });
        const run = h.plan(['a', 'b']);
        h.generation.refreshModelConfig = async () => copy(h.capabilities.current);
        let announceFirst, announceSecond, release;
        const firstStarted = new Promise(resolve => { announceFirst = resolve; });
        const secondStarted = new Promise(resolve => { announceSecond = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        const original = h.bridge.generateImageFromRenderer;
        let active = 0;
        h.bridge.generateImageFromRenderer = async body => {
            active++;
            assert.equal(body.concurrency, 3);
            if (active === 1) {
                announceFirst();
                await gate;
            } else announceSecond();
            return original(body);
        };
        const first = h.execute(run.steps[0], run);
        await firstStarted;
        const second = h.execute(run.steps[1], run);
        await secondStarted;
        await second;
        release();
        await first;
        assert.equal(h.requests.length, 2);
    });

    test('built-in Agent and external Harness list/prepare/execute read the same live snapshot', async t => {
        const h = await setup(t, { providers: mjProviders });
        let state = { activeGroupId: 'original', items: copy(h.projects.original.items), connections: [], plans: [],
            folderGroups: [{ id: 'original', savedItems: copy(h.projects.original.items), connections: [], plans: [], defaultSaveFolder: h.directory }] };
        const window = { isDestroyed: () => false, webContents: { send() {},
            executeJavaScript: async () => ({ config: copy(h.capabilities.current), status: { origin: 'cache' } }) } };
        const services = await createAgentServices({ store: { load: () => copy(state), save: value => { state = copy(value); return true; } },
            apiConfigStore: { load: () => ({ config: h.config }) }, bridge: h.bridge, dataDir: h.directory,
            getSaveDir: () => h.directory, getMainWindow: () => window,
            net: { fetch: () => { throw new Error('Network calls are forbidden in this test'); } } });
        t.after(() => services.close());
        const context = { id: 'internal', projectId: 'original', attachments: [] };
        assert.deepEqual(await services.runtime.executeTool(context, 'flow_canvas.model.list', {}),
            await h.bridge.agentExecutor('flow_canvas.model.list'));
        const run = { id: 'integration', projectId: 'original', steps: [] };
        run.steps = (await services.runtime.prepareGraph(run, { nodeIds: ['image'] })).steps;
        entry(h, 'midjourney.mj-imagine').options.resolutionTier = { type: 'tier', values: ['2K'], default: '2K' };
        assert.deepEqual((await h.bridge.agentExecutor('flow_canvas.model.list'))[0].resolutions, ['2K']);
        await assert.rejects(services.runtime.executeStep(run.steps[0], run, { checkpoint() {} }), { code: 'INVALID_RESOLUTION' });
        assert.equal(h.requests.length, 0);
    });
});

describe('AgentGeneration execution', () => {
    test('terminal bridge errors retain UPSTREAM_TASK_FAILED and their original details', async t => {
        for (const [nodeType, resume] of [['image', false], ['video', false], ['image', true], ['video', true]]) {
            const h = await setup(t, { items: [op('target', nodeType)] });
            const run = h.plan(['target']);
            const failure = Object.assign(new Error('Remote task failed permanently'), {
                code: 'UPSTREAM_TASK_FAILED', taskId: 'remote-failed', details: { terminal: true }
            });
            if (resume) run.steps[0].remoteTaskId = failure.taskId;
            const method = `${resume ? 'resume' : 'generate'}${nodeType === 'image' ? 'Image' : 'Video'}FromRenderer`;
            h.bridge[method] = async () => { throw failure; };
            await assert.rejects(h.execute(run.steps[0], run, { resume }), actual => actual === failure
                && actual.code === 'UPSTREAM_TASK_FAILED' && actual.details.terminal === true);
        }
    });

    test('capsules use upload order and keep raw drafts through Agent generation and reuse', async t => {
        const h = await setup(t);
        const first = await h.file('first.png'), second = await h.file('second.png');
        h.projects.original.items.push({ id: 'first', kind: 'media', mediaType: 'image', filePath: first },
            { id: 'second', kind: 'media', mediaType: 'image', filePath: second });
        h.projects.original.connections = [edge('second', 'image'), edge('first', 'image')];
        h.projects.original.items[0].config = { prompt: 'A B C', count: 1,
            referenceCitationIds: ['first-image', 'second-image'], referenceCitationLabels: ['图一', '图二'],
            referenceCitationOccurrences: [
                { id: 'a', connectionId: 'first-image', sourceNodeId: 'first', offset: 0 },
                { id: 'b', connectionId: 'second-image', sourceNodeId: 'second', offset: 2 },
                { id: 'c', connectionId: 'first-image', sourceNodeId: 'first', offset: 4 }
            ] };
        const run = h.plan();
        const result = await h.execute(run.steps[0], run);
        const sent = h.requests[0].body;
        assert.deepEqual(sent.sourceReferences.map(ref => ref.filePath), [second, first]);
        assert.match(sent.prompt, /\n图二A 图一B 图二C$/);
        assert.equal(sent.promptDraftConfig.prompt, 'A B C');
        const output = h.projects.original.items.find(node => node.id === result.nodeIds[0]);
        assert.equal(output.config.prompt, 'A B C');
        assert.equal(getGenerationReuseConfig(output).referenceCitationOccurrences.length, 3);
        assert.equal(output.generation.requestPrompt, sent.prompt);
        const reused = h.plan(result.nodeIds);
        assert.equal(reused.steps[0].prompt, sent.prompt);
    });

    test('references to newly generated upstream nodes keep stable output identities', async t => {
        const h = await setup(t, { items: [op('a'), op('b', 'image', { prompt: 'use ',
            referenceCitationIds: ['a-b'], referenceCitationLabels: ['图一'], referenceCitationOffsets: { 'a-b': 4 } })],
        connections: [edge('a', 'b')] });
        const run = h.plan(['b']);
        const first = await h.execute(run.steps[0], run);
        run.results = [first];
        const second = await h.execute(run.steps[1], run);
        const output = h.projects.original.items.find(node => node.id === second.nodeIds[0]);
        assert.equal(output.generation.referenceBindings[0].sourceNodeId, first.nodeIds[0]);
        assert.equal(output.generation.promptDraftConfig.referenceCitationOccurrences[0].sourceNodeId, first.nodeIds[0]);
        assert.equal(h.plan(second.nodeIds).steps[0].prompt, run.steps[1].prompt);
    });

    test('missing stable capsules prevent Agent plan approval', async t => {
        const h = await setup(t);
        h.projects.original.items[0].config.referenceCitationOccurrences = [{ id: 'missing', missing: true }];
        assert.throws(() => h.plan(), /失联/);
        assert.equal(h.requests.length, 0);
    });

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
        // Resolve both sides with the same API; Windows may return an 8.3 path alias.
        assert.equal(await fs.realpath(h.frameCalls[0][0]), await fs.realpath(h.filePath));
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
