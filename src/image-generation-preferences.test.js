import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createImageNodePromptDraft,
    getImageGenerationPreferences,
    imageGenerationPreferenceKey,
    mergeImageNodePromptConfig,
    saveImageGenerationPreferences
} from './image-generation-preferences.js';

test('image generation preferences are isolated by provider and model without carrying node prompts', () => {
    const gpt = { sourceProviderId: 'api-1', providerId: 'api-1', model: 'gpt-image-2' };
    const mj = { sourceProviderId: 'api-1', providerId: 'api-1::model:mj', model: 'mj_imagine' };
    let store = saveImageGenerationPreferences({}, {
        prompt: 'gpt prompt', quality: 'high', midjourneyVersion: '7'
    }, gpt);
    store = saveImageGenerationPreferences(store, {
        prompt: 'mj prompt', midjourneyVersion: '8.2', midjourneyStylize: 800
    }, mj);

    assert.equal(imageGenerationPreferenceKey(gpt), 'api-1::gpt-image-2');
    assert.deepEqual(getImageGenerationPreferences(store, gpt), {
        quality: 'high', midjourneyVersion: '7'
    });
    assert.deepEqual(getImageGenerationPreferences(store, mj), {
        midjourneyVersion: '8.2', midjourneyStylize: 800
    });
});

test('saving a model preference preserves omitted values from the same model', () => {
    const binding = { sourceProviderId: 'api-2', providerId: 'api-2', model: 'mj_imagine' };
    let store = saveImageGenerationPreferences({}, {
        prompt: 'keep me', midjourneyVersion: '7', midjourneyRaw: true
    }, binding);
    store = saveImageGenerationPreferences(store, { midjourneyStylize: 600 }, binding);

    assert.deepEqual(getImageGenerationPreferences(store, binding), {
        midjourneyVersion: '7', midjourneyRaw: true, midjourneyStylize: 600
    });
});

test('generated image nodes restore their own prompt and prefer their local draft', () => {
    const source = {
        generation: {
            config: {
                prompt: '生成时提示词',
                negativePrompt: '生成时反向词',
                quality: 'high'
            }
        },
        generationPromptDraft: createImageNodePromptDraft({
            prompt: '该节点的新草稿',
            promptMergeMode: 'prepend'
        }, 1234)
    };

    assert.deepEqual(mergeImageNodePromptConfig({
        prompt: '',
        promptMergeMode: 'append',
        quality: 'medium'
    }, source), {
        prompt: '该节点的新草稿',
        promptMergeMode: 'prepend',
        negativePrompt: '生成时反向词',
        quality: 'medium'
    });
    assert.equal(source.generationPromptDraft.updatedAt, 1234);
});

test('image API preferences are persisted with the model-specific settings', () => {
    const binding = { sourceProviderId: 'api-3', providerId: 'api-3', model: 'gpt-image-2' };
    const store = saveImageGenerationPreferences({}, {
        responseFormat: 'b64_json',
        historyDisabled: false,
        stream: true
    }, binding);

    assert.deepEqual(getImageGenerationPreferences(store, binding), {
        responseFormat: 'b64_json',
        historyDisabled: false,
        stream: true
    });
});
