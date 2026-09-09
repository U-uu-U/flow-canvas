import test from 'node:test';
import assert from 'node:assert/strict';

let records;
test.before(async () => {
    records = await import('./generation-record.js');
});

test('media generation records prefer the actual submitted prompt', () => {
    const data = {
        kind: 'media',
        mediaType: 'image',
        generation: {
            nodeType: 'image',
            prompt: 'actual provider prompt',
            model: 'gpt-image-2',
            config: { prompt: 'node draft', width: 2048, height: 2048, quality: 'high' }
        }
    };
    const record = records.getGenerationRecord(data);
    assert.equal(record.prompt, 'actual provider prompt');
    assert.equal(records.getGenerationReuseConfig(data, { count: 1 }).prompt, 'actual provider prompt');
    assert.deepEqual(records.getGenerationParameterEntries(data, 3), [
        { key: 'model', label: '模型', value: 'gpt-image-2' },
        { key: 'size', label: '尺寸', value: '2048x2048' },
        { key: 'quality', label: '质量', value: 'high' }
    ]);
});

test('completed video operation nodes expose reusable generation records', () => {
    const data = {
        kind: 'op',
        nodeType: 'video',
        resultFilePaths: ['D:/output.mp4'],
        config: {
            prompt: 'animate this scene',
            model: 'minimax-h3',
            resolution: '2K',
            ratio: '16:9',
            duration: 10,
            generateAudio: true
        }
    };
    assert.equal(records.hasGenerationRecord(data), true);
    assert.deepEqual(records.getGenerationParameterEntries(data), [
        { key: 'model', label: '模型', value: 'minimax-h3' },
        { key: 'resolution', label: '分辨率', value: '2K' },
        { key: 'ratio', label: '比例', value: '16:9' },
        { key: 'duration', label: '时长', value: '10秒' }
    ]);
});

test('direct workspace image records restore dimensions and provider binding', () => {
    const config = records.getGenerationReuseConfig({
        kind: 'media',
        mediaType: 'image',
        generation: {
            nodeType: 'image',
            prompt: 'reuse this',
            model: 'gpt-image-2',
            providerId: 'provider::gpt-image-2',
            sourceProviderId: 'provider',
            config: { size: '1536x1024', quality: 'high' }
        }
    }, { width: 1024, height: 1024 });

    assert.equal(config.prompt, 'reuse this');
    assert.equal(config.model, 'gpt-image-2');
    assert.equal(config.providerId, 'provider::gpt-image-2');
    assert.equal(config.sourceProviderId, 'provider');
    assert.equal(config.width, 1536);
    assert.equal(config.height, 1024);
});

test('ordinary media does not pretend to have generation history', () => {
    assert.equal(records.hasGenerationRecord({ kind: 'media', mediaType: 'image' }), false);
});
