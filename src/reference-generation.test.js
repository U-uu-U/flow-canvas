import test from 'node:test';
import assert from 'node:assert/strict';
import { NODE_TYPES, expandGenerationPrompts } from './node-types.js';
import { getGenerationReuseConfig } from './generation-record.js';

for (const kind of ['image', 'video']) {
    test(`${kind}: repeated reuse keeps one guide, stable citations, and one upload per asset`, async t => {
        const previousWindow = global.window;
        t.after(() => { global.window = previousWindow; });
        const calls = [];
        const tasks = [];
        const generate = async payload => {
            calls.push(payload);
            return { filePath: `/output/result.${kind === 'image' ? 'png' : 'mp4'}` };
        };
        global.window = { flowCanvas: { mcp: { generateImage: generate, generateVideo: generate } } };
        const references = ['/first.png', '/second.png'];
        const inputs = { source: [...references, references[0]].map(value => `local-res://${encodeURIComponent(value)}`) };
        const context = references.map((filePath, index) => ({ connectionId: `new-${index}`, source: { id: `ref-${index}`, filePath } }));
        let config = { prompt: 'A B C', count: 1, concurrency: 1, width: 1024, height: 1024,
            duration: 30, promptMergeMode: 'append', skipImageIntentPipeline: true,
            referenceCitationIds: ['old-0', 'old-1'], referenceCitationLabels: ['图一', '图二'],
            referenceCitationOccurrences: [
                { id: 'a', connectionId: 'old-0', sourceNodeId: 'ref-0', offset: 0 },
                { id: 'b', connectionId: 'old-1', sourceNodeId: 'ref-1', offset: 2 },
                { id: 'c', connectionId: 'old-0', sourceNodeId: 'ref-0', offset: 4 }
            ] };
        const provider = { apiKey: 'test-secret', endpoint: 'https://example.test/v1', model: kind === 'image' ? 'gpt-image-2' : 'sd2.5' };
        for (let iteration = 0; iteration < 3; iteration++) {
            const before = structuredClone(config);
            const result = await NODE_TYPES[kind].execute(inputs, config, {
                item: { id: 'target' }, inputContext: context,
                getImageProvider: () => provider, getVideoProvider: () => provider,
                prepareImageReferences: refs => refs.map(ref => ({ filePath: ref.filePath.replace('.png', '-small.png') })),
                createGenerationTask: task => { tasks.push(task); return { id: `task-${iteration}`, projectId: 'original-project' }; }
            });
            assert.deepEqual(config, before, 'execution must not edit the live draft');
            assert.equal(result._generation.promptDraftConfig.prompt, 'A B C');
            assert.equal(result._generation.config.prompt, 'A B C');
            assert.equal(result._generation.requestPrompt, calls[iteration].prompt);
            assert.deepEqual(result._generation.referenceBindings.map(ref => ref.filePath), references);
            config = getGenerationReuseConfig({ kind: 'media', mediaType: kind, generation: result._generation });
            assert.equal(config.referenceCitationOccurrences.length, 3);
        }
        assert.equal(calls.length, 3);
        for (const [index, call] of calls.entries()) {
            assert.equal(call.prompt, '参考图编号与上传顺序一致：图一=第1张，图二=第2张。\n图一A 图二B 图一C');
            assert.equal(call.userPrompt, '图一A 图二B 图一C');
            assert.equal(call.projectId, 'original-project');
            assert.deepEqual(call.sourceReferences.map(ref => ref.filePath), ['/first-small.png', '/second-small.png']);
            assert.deepEqual(tasks[index].promptDraftConfig, call.promptDraftConfig);
            assert.equal(JSON.stringify(call.promptDraftConfig).includes('test-secret'), false);
        }
    });
}

test('saved upstream text is reused only when live upstream text is unavailable', () => {
    const config = { prompt: 'local', generationUpstreamPrompts: ['saved'] };
    assert.deepEqual(expandGenerationPrompts({}, config), ['local\n\nsaved']);
    assert.deepEqual(expandGenerationPrompts({ prompt: ['live'] }, config), ['local\n\nlive']);
});

test('missing citations fail before task creation or API submission', async () => {
    for (const kind of ['image', 'video']) {
        await assert.rejects(NODE_TYPES[kind].execute({}, {
            prompt: 'draft', referenceCitationOccurrences: [{ id: 'lost', missing: true }]
        }, { createGenerationTask: () => assert.fail('must not create a paid task') }), /失联/);
    }
});

test('Agent-compiled requests retain the user draft in task history', async t => {
    const previousWindow = global.window;
    t.after(() => { global.window = previousWindow; });
    let sent;
    global.window = { flowCanvas: { mcp: { generateImage: async payload => {
        sent = payload;
        return { filePath: '/result.png' };
    } } } };
    await NODE_TYPES.image.execute({}, { prompt: 'user instruction', agentCompiledPrompt: 'expanded Agent instruction',
        width: 1024, height: 1024, skipImageIntentPipeline: true }, {
        item: { id: 'target' }, getImageProvider: () => ({ apiKey: 'fixture', model: 'gpt-image-2' })
    });
    assert.equal(sent.prompt, 'expanded Agent instruction');
    assert.equal(sent.userPrompt, 'user instruction');
    assert.equal(sent.promptDraftConfig.prompt, 'user instruction');
});
