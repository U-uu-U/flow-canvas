const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Bridge = require('./mcp-bridge');

test('image submission fails before provider access when any selected reference is unavailable', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-reference-validation-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const valid = path.join(directory, 'valid.png');
    const unsupported = path.join(directory, 'unsupported.gif');
    fs.writeFileSync(valid, 'fixture');
    fs.writeFileSync(unsupported, 'fixture');
    const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(directory, 'records') });
    bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
    for (const bad of [{ filePath: path.join(directory, 'missing.png') }, { filePath: unsupported }, { itemId: 'missing-node' }]) {
        await assert.rejects(bridge._generateImageFromRenderer({
            prompt: 'combine both images', targetDir: directory, provider: 'openai',
            sourceReferences: [{ filePath: valid }, bad]
        }), /参考图未完整添加，已停止生成/);
    }
});
