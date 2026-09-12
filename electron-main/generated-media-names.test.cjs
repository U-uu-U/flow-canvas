const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { namingPrompt, extractGenerationName, writeGeneratedMedia } = require('./generated-media-names.cjs');

function folder(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-media-names-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test('naming uses the user draft instead of the Agent expansion, without modifying the request', () => {
    const request = { userPrompt: '雨夜街道', promptDraftConfig: { prompt: '原始草稿' }, prompt: 'compiled prompt' };
    const before = structuredClone(request);
    assert.equal(namingPrompt(request), '雨夜街道');
    assert.equal(namingPrompt({ ...request, userPrompt: '' }), '原始草稿');
    assert.equal(namingPrompt({ prompt: 'raw prompt' }), 'raw prompt');
    assert.equal(namingPrompt({}, 'fallback'), 'fallback');
    assert.deepEqual(request, before);
});

test('rules remove command prefixes, citation guides, tokens, URLs and MJ parameters', () => {
    assert.equal(extractGenerationName('请帮我生成一张雨夜街道人物。保持原有画幅。'), '雨夜街道人物');
    assert.equal(extractGenerationName('参考图编号与上传顺序一致：图一=第1张。\n图一 图二 雨夜街道 --ar 16:9 --v 7'), '雨夜街道');
    assert.equal(extractGenerationName('https://example.test/a.png [[image:node-a]] @image1 雨夜街道'), '雨夜街道');
    assert.equal(extractGenerationName('Please generate a cinematic rainy street --ar 16:9'), 'cinematic_rainy_street');
    assert.equal(extractGenerationName('请生成一张图片。\n雨夜街道人物'), '雨夜街道人物');
    assert.equal(extractGenerationName(''), '未命名');
    assert.equal(extractGenerationName('https://example.test/a.png'), '未命名');
});

test('names are short and safe on Windows and macOS without splitting Unicode code points', () => {
    for (const prompt of ['../CON:<bad>|?*', 'NUL', '雨夜街道'.repeat(100), 'A cinematic scene with warm lighting and reflections '.repeat(20), '\u202e\u0000']) {
        const name = extractGenerationName(prompt);
        assert.ok(name);
        assert.doesNotMatch(name, /[<>:"/\\|?*\p{Cc}\p{Cf}]/u);
        assert.ok(Array.from(name).length <= 48);
        assert.ok(Buffer.byteLength(name) < 150);
    }
});

test('new outputs count upward across file formats and never rename or replace an existing asset', t => {
    const targetDir = folder(t);
    const options = { targetDir, prompt: '请生成雨夜街道', mediaType: 'image' };
    const original = writeGeneratedMedia(Buffer.from('first'), { ...options, extension: '.png' });
    const next = writeGeneratedMedia(Buffer.from('second'), { ...options, extension: '.webp' });
    assert.equal(path.basename(original), '雨夜街道_图片_001.png');
    assert.equal(path.basename(next), '雨夜街道_图片_002.webp');
    assert.equal(fs.readFileSync(original, 'utf8'), 'first');
    const video = writeGeneratedMedia(Buffer.from('video'), { ...options, mediaType: 'video', extension: '.mp4' });
    assert.equal(path.basename(video), '雨夜街道_视频_001.mp4');
    fs.writeFileSync(path.join(targetDir, '雨夜街道_图片_010_U4.png'), 'existing candidate');
    const afterRestart = writeGeneratedMedia(Buffer.from('third'), options);
    assert.equal(path.basename(afterRestart), '雨夜街道_图片_011.png');
});

test('concurrent writers cannot overwrite an existing file even if it appears after the directory scan', t => {
    const targetDir = folder(t);
    const open = fs.openSync;
    let injected = false;
    t.mock.method(fs, 'openSync', (filePath, flags, ...rest) => {
        if (flags === 'wx' && !injected) {
            injected = true;
            fs.writeFileSync(filePath, 'other writer');
        }
        return open(filePath, flags, ...rest);
    });
    const filePath = writeGeneratedMedia(Buffer.from('ours'), { targetDir, prompt: 'Product' });
    assert.equal(path.basename(filePath), 'Product_图片_002.png');
    assert.equal(fs.readFileSync(path.join(targetDir, 'Product_图片_001.png'), 'utf8'), 'other writer');
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'ours');
});

test('independent processes writing the same prompt get distinct files and retain every payload', async t => {
    const targetDir = folder(t);
    const script = `const { writeGeneratedMedia } = require(process.argv[2]);
        for (let i = 0; i < 4; i++) writeGeneratedMedia(Buffer.from(process.argv[3] + ':' + i),
            { targetDir: process.argv[1], prompt: 'Shared output' });`;
    const run = promisify(execFile);
    await Promise.all(['a', 'b', 'c'].map(id => run(process.execPath,
        ['-e', script, targetDir, require.resolve('./generated-media-names.cjs'), id])));
    const files = fs.readdirSync(targetDir);
    assert.equal(files.length, 12);
    assert.deepEqual(files.map(file => fs.readFileSync(path.join(targetDir, file), 'utf8')).sort(),
        ['a', 'b', 'c'].flatMap(id => [0, 1, 2, 3].map(index => `${id}:${index}`)));
});

test('real outputs cannot acquire the reserved prefixes used to hide internal placeholders', t => {
    const targetDir = folder(t);
    for (const prompt of ['flow_builtin', 'flow_builtin example', 'flow_source_builtin example']) {
        const filePath = writeGeneratedMedia(Buffer.from('output'), { targetDir, prompt });
        assert.doesNotMatch(path.basename(filePath), /^flow_(?:source_)?builtin_/i);
    }
});

test('sequence scans handle decomposed macOS Unicode names and case-folded names', t => {
    const targetDir = folder(t);
    for (const summary of ['Caf\u00e9', '\u0130stanbul']) {
        fs.writeFileSync(path.join(targetDir, `${summary}_图片_007.png`.normalize('NFD')), 'existing');
        const filePath = writeGeneratedMedia(Buffer.from('next'), { targetDir, prompt: summary, extension: '.webp' });
        assert.ok(filePath.endsWith('_008.webp'), filePath);
    }
});

test('failed writes remove only their own incomplete file and invalid extensions fail before writing', t => {
    const targetDir = folder(t);
    const keep = path.join(targetDir, 'original.png');
    fs.writeFileSync(keep, 'keep');
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
        if (typeof file === 'number') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return write(file, ...args);
    });
    assert.throws(() => writeGeneratedMedia(Buffer.from('test'), { targetDir, prompt: 'new' }), /disk full/);
    assert.deepEqual(fs.readdirSync(targetDir), ['original.png']);
    assert.equal(fs.readFileSync(keep, 'utf8'), 'keep');
    assert.throws(() => writeGeneratedMedia(Buffer.from('test'), { targetDir, extension: '/../escape' }), /extension/);
});
