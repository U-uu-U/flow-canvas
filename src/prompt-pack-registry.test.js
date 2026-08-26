const test = require('node:test');
const assert = require('node:assert/strict');

let promptPacks;
test.before(async () => {
    promptPacks = await import('./prompt-pack-registry.js');
});

test('精简提示词包只注册结构化模板', () => {
    const pack = promptPacks.getPromptPack(promptPacks.DEFAULT_IMAGE_PROMPT_PACK_ID);
    assert.equal(pack.name, 'Awesome GPT Image 2');
    assert.equal(pack.templates.length, 22);
    assert.equal('cases' in pack, false);
    assert.equal('images' in pack, false);
    assert.match(pack.licenseNotice, /Copyright \(c\) 2026 freestylefly/);
});

test('支持按分类和中文关键词筛选模板', () => {
    const results = promptPacks.findPromptTemplates(promptPacks.DEFAULT_IMAGE_PROMPT_PACK_ID, {
        query: '摄影 写实',
        category: 'Photography & Realism'
    });
    assert.ok(results.length >= 1);
    assert.ok(results.every(template => template.category === 'Photography & Realism'));
});

test('增强模式保留原提示词并追加模板约束', () => {
    const [template] = promptPacks.findPromptTemplates(promptPacks.DEFAULT_IMAGE_PROMPT_PACK_ID, {
        query: '商品商业视觉'
    });
    const output = promptPacks.composePromptFromTemplate(template, '生成一张柠檬饮料海报', 'enhance');
    assert.match(output, /^生成一张柠檬饮料海报/);
    assert.match(output, /创作方向：商品商业视觉/);
    assert.match(output, /执行要求：/);
    assert.match(output, /约束：/);
});

test('写入模式生成可继续填写的结构模板', () => {
    const [template] = promptPacks.findPromptTemplates(promptPacks.DEFAULT_IMAGE_PROMPT_PACK_ID, {
        query: '角色设定表'
    });
    const output = promptPacks.composePromptFromTemplate(template, '会被替换', 'template');
    assert.match(output, /^创作任务：/);
    assert.equal(output.includes('会被替换'), false);
});
