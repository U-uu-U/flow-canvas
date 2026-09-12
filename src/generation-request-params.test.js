import test from 'node:test';
import assert from 'node:assert/strict';
import { imageGenerationRequestParams, normalizeVideoGenerationResolution } from './generation-request-params.js';

test('image params provide transport defaults and honor explicit pixel dimensions', () => {
    assert.deepEqual(imageGenerationRequestParams(), {
        size: '1024x1024', quality: 'high', responseFormat: 'url', historyDisabled: true,
        stream: false, webSearch: undefined, nodeId: null
    });
    assert.equal(imageGenerationRequestParams({ width: 2048, height: 1360 }).size, '2048x1360');
    assert.equal(imageGenerationRequestParams({ size: '3840x2160', width: 512, height: 512 }).size, '3840x2160');
});

test('image params only enable GPT Image 2 transport options on the matching model', () => {
    const config = Object.freeze({ quality: 'medium', responseFormat: 'b64_json', historyDisabled: false, stream: true, webSearch: true });
    assert.deepEqual(imageGenerationRequestParams(config, 'gpt-image-2', 'node-1'), {
        size: '1024x1024', quality: 'medium', responseFormat: 'b64_json', historyDisabled: false,
        stream: true, webSearch: true, nodeId: 'node-1'
    });
    assert.deepEqual(imageGenerationRequestParams(config, 'gpt-image-2.5-sunburst', 'node-2'), {
        size: '1024x1024', quality: 'medium', responseFormat: 'url', historyDisabled: true,
        stream: false, webSearch: true, nodeId: 'node-2'
    });
});

test('webSearch is explicit opt-in and omitted from serialized requests when disabled', () => {
    for (const webSearch of [undefined, false, 0, 1, 'true']) {
        const params = imageGenerationRequestParams({ webSearch }, 'gpt-image-2');
        assert.equal(params.webSearch, undefined);
        assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(params)), 'webSearch'), false);
    }
    assert.equal(imageGenerationRequestParams({ webSearch: true }, 'mj_imagine').webSearch, true);
});

test('MJ mapping retains all supported controls and does not mutate the input', () => {
    const config = Object.freeze({ resolutionTier: '2K', ratio: '9:16', midjourneyVersion: '8.2', midjourneyRaw: true,
        midjourneyStylize: 0, midjourneyChaos: 0, midjourneyWeird: 0, midjourneyQuality: 0.5, midjourneyImageWeight: 0,
        midjourneyStyleReference: 'style-ref', midjourneyStyleWeight: 0, midjourneyStyleVersion: 6,
        midjourneyOmniReference: 'omni-ref', midjourneyOmniWeight: 1, midjourneyProfile: 'profile', midjourneySeed: 0,
        midjourneyTile: true, midjourneyDraft: true, midjourneyRepeat: 2, midjourneySpeed: 'relax', midjourneyVisibility: 'stealth',
        negativePrompt: 'blur', webSearch: true });
    const before = structuredClone(config);
    const expected = { ratio: '9:16', version: '8.2', raw: true, stylize: 0, chaos: 0, weird: 0, quality: 0.5,
        imageWeight: 0, styleReference: 'style-ref', styleWeight: 0, styleVersion: 6, omniReference: 'omni-ref', omniWeight: 1,
        profile: 'profile', seed: 0, tile: true, draft: true, repeat: 2, speed: 'relax', visibility: 'stealth',
        definition: 'hd', negativePrompt: 'blur' };
    for (const model of ['mj_imagine', 'midjourney', 'MJ-IMAGINE']) {
        const params = imageGenerationRequestParams(config, model);
        assert.deepEqual(params.midjourney, expected);
        assert.equal(params.webSearch, true);
    }
    assert.equal(imageGenerationRequestParams(config, 'gpt-image-2').midjourney, undefined);
    assert.deepEqual(config, before);
});

test('MJ supported tiers encode sd/hd and absent switches stay disabled', () => {
    for (const [resolutionTier, definition] of [['1K', 'sd'], ['2K', 'hd']]) {
        const params = imageGenerationRequestParams({ resolutionTier }, 'midjourney');
        assert.equal(params.midjourney.definition, definition);
        assert.equal(params.midjourney.raw, false);
        assert.equal(params.midjourney.tile, false);
        assert.equal(params.midjourney.draft, false);
    }
});

test('H3 normalization migrates legacy 720p and case while leaving other model resolutions intact', () => {
    for (const model of ['minimax-h3', 'MiniMax_H3', 'minimax-h3-native']) {
        for (const [value, expected] of [['720p', '768p'], [' 720P ', '768p'], ['2K', '2k'], ['4K', '4k'], ['1080P', '1080p'], ['768p', '768p']]) {
            assert.equal(normalizeVideoGenerationResolution(model, value), expected);
            assert.equal(normalizeVideoGenerationResolution(model, expected), expected);
        }
        for (const value of [undefined, null, '']) assert.equal(normalizeVideoGenerationResolution(model, value), value);
    }
    for (const model of ['seedance_v2.5', 'sd2.5', 'custom-video', '', undefined]) {
        for (const value of ['720p', '2K', ' Custom ', undefined]) assert.equal(normalizeVideoGenerationResolution(model, value), value);
    }
});
