import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphRunner } from './graph-runner.js';
import { AgentSidebar } from './agent-sidebar.js';
import { assertModelRequest, checkModelRequest } from './model-config-ui.js';

async function generate(t, kind, model, ownPrompt, upstreamPrompt, extraConfig = {}) {
    const previousWindow = globalThis.window;
    const requests = [];
    const submit = async request => {
        requests.push(request);
        return { success: true, url: `https://example.invalid/result.${kind === 'image' ? 'png' : 'mp4'}` };
    };
    globalThis.window = { flowCanvas: { mcp: { generateImage: submit, generateVideo: submit } } };
    t.after(() => { globalThis.window = previousWindow; });
    const items = [
        { id: 'text', kind: 'op', nodeType: 'text', config: { text: upstreamPrompt } },
        { id: 'target', kind: 'op', nodeType: kind, config: {
            prompt: ownPrompt, promptMergeMode: 'append', duration: 30,
            resolution: '720p', ratio: '16:9', ...extraConfig
        } }
    ];
    const provider = { model, apiKey: 'mock-only', endpoint: 'https://example.invalid/v1' };
    const validations = [];
    const runner = new GraphRunner({
        getItems: () => items,
        getConnections: () => [{ id: 'text-target', from: { nodeId: 'text', port: 'text' }, to: { nodeId: 'target', port: 'source' } }],
        getImageProvider: () => provider, getVideoProvider: () => provider,
        getImageIntentPipelineMode: () => 'off',
        validateGenerationRequest: request => { validations.push(request); return assertModelRequest(request); }
    });
    return { result: await runner.runFrom('target'), requests, validations };
}

for (const [kind, model] of [['image', 'gpt-image-2.5-sunburst'], ['video', 'sd2.5-route1']]) {
    test(`${kind} generation validates resolved upstream text and accepts an empty local prompt`, async t => {
        const preflight = checkModelRequest({ kind, provider: { model }, prompt: '', promptResolved: false });
        assert.equal(preflight.ok, true);
        const { result, requests, validations } = await generate(t, kind, model, '', 'upstream-only prompt');
        assert.equal(result.ok, true, result.reason);
        assert.equal(requests.length, 1);
        assert.equal(validations.length, 1);
        assert.equal(requests[0].prompt, 'upstream-only prompt');
        assert.equal(validations[0].prompt, requests[0].prompt);
    });
}

test('merged H3 prompt length is checked before media submission', async t => {
    const { result, requests, validations } = await generate(t, 'video', 'minimax-h3', 'a'.repeat(3000), 'b'.repeat(3000), {
        duration: 5, resolution: '2k'
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /5000/);
    assert.equal(requests.length, 0);
    assert.ok(validations[0].prompt.length > 5000);
});

test('fixed-route validation also guards graph execution without a composer', async t => {
    const { result, requests } = await generate(t, 'video', 'sd2.5', 'prompt', '', { duration: 5 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /30/);
    assert.equal(requests.length, 0);
});

test('canvas provider profiles preserve configured video options and MJ image sizes', () => {
    for (const model of ['sd2.5-route1', 'sd2.5', 'seedance_v2.5', 'minimax-h3']) {
        const provider = { model, endpoint: 'https://art.ravenhash.org/v1' };
        const sidebar = Object.create(AgentSidebar.prototype);
        sidebar._getVideoProvider = () => provider;
        sidebar._getBoundProvider = () => provider;
        const controls = sidebar._getVideoModelProfile(provider);
        const canvas = sidebar.getVideoModelProfile();
        for (const key of ['durations', 'resolutions', 'ratios', 'supportsGeneratedAudio']) {
            assert.deepEqual(canvas[key], controls[key], `${model}.${key}`);
        }
    }
    const sidebar = Object.create(AgentSidebar.prototype);
    const sizes = sidebar._getImageModelSizes({ model: 'mj_imagine', endpoint: 'https://ai.ravenhash.org/v1' });
    assert.equal(sizes.some(size => /3840|4096/.test(size.value)), false);
    assert.ok(sizes.some(size => size.value === '1024x1024'));
});
