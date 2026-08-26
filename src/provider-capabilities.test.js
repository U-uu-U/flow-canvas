const test = require('node:test');
const assert = require('node:assert/strict');

let helpers;
test.before(async () => {
    helpers = await import('./provider-capabilities.js');
});

test('显式用途优先于相同的 RavenHash URL 和模型名推断', () => {
    const endpoint = 'https://ai.ravenhash.org/v1';
    assert.equal(helpers.inferProviderCapability({ endpoint, model: 'gpt-5.5', capability: 'text' }), 'text');
    assert.equal(helpers.inferProviderCapability({ endpoint, model: 'gpt-image-2', capability: 'text' }), 'text');
    assert.equal(helpers.inferProviderCapability({ endpoint, model: 'gpt-5.5', capability: 'image' }), 'image');
});

test('旧配置继续按模型信息推断用途', () => {
    assert.equal(helpers.inferProviderCapability({ model: 'gpt-image-2' }), 'image');
    assert.equal(helpers.inferProviderCapability({ model: 'doubao-seedance-2-0' }), 'video');
    assert.equal(helpers.inferProviderCapability({ model: 'gpt-5.5' }), 'text');
    assert.equal(helpers.inferProviderCapability({ capability: 'chat' }), 'text');
    assert.equal(helpers.inferProviderCapability({ capability: 'vision' }), 'text');
    assert.equal(helpers.inferProviderCapability({ capability: 'multimodal' }), 'text');
});

test('Midjourney 图片模型只匹配初始四宫格生成动作', () => {
    assert.equal(helpers.isMidjourneyImageModel('mj_imagine'), true);
    assert.equal(helpers.isMidjourneyImageModel('Midjourney'), true);
    assert.equal(helpers.isMidjourneyImageModel('mj_upscale'), false);
    assert.equal(helpers.isMidjourneyImageModel('gpt-image-2'), false);
});
