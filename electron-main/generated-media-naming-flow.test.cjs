const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const sharp = require('sharp');

let fetchFixture;
let fixtureProfile;
const originalLoad = Module._load;
let Bridge;
try {
    Module._load = function (name, ...args) {
        return name === 'electron' ? { app: { getPath: () => fixtureProfile }, net: { fetch: (...input) => fetchFixture(...input) } }
            : originalLoad.call(this, name, ...args);
    };
    Bridge = require('./mcp-bridge');
} finally {
    Module._load = originalLoad;
}

function setup(t) {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-naming-flow-'));
    fixtureProfile = targetDir;
    t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));
    const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(targetDir, 'records') });
    bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
    const body = { prompt: 'compiled instruction for the provider', userPrompt: '请生成雨夜街道',
        targetDir, addToCanvas: false, provider: 'openai',
        providerConfig: { endpoint: 'https://fixture.test/v1', apiKey: 'fixture-only', model: 'gpt-image-2' } };
    return { bridge, targetDir, body };
}

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('builtin placeholders retain their internal prefix rather than masquerading as generated media', async t => {
    const { bridge, body } = setup(t);
    fetchFixture = () => assert.fail('builtin placeholder must not call a provider');
    const result = await bridge._generateImageFromRenderer({ ...body, provider: 'builtin', width: 256, height: 256 });
    assert.equal(result.provider, 'builtin');
    assert.equal(result.item, null);
    assert.match(path.basename(result.filePath), /^flow_builtin_[a-f0-9]+\.png$/);
});

test('image generation and ID recovery preserve candidate order despite out-of-order downloads', { timeout: 10000 }, async t => {
    const { bridge, body } = setup(t);
    const first = await sharp({ create: { width: 16, height: 8, channels: 3, background: '#808080' } }).png().toBuffer();
    const second = await sharp({ create: { width: 8, height: 16, channels: 3, background: '#909090' } }).png().toBuffer();
    let posts = 0;
    const downloaded = [];
    fetchFixture = async (url, options = {}) => {
        assert.equal(new URL(url).hostname, 'fixture.test');
        if (url.endsWith('/first.png') || url.endsWith('/second.png')) {
            if (url.endsWith('/first.png')) await new Promise(resolve => setTimeout(resolve, 30));
            downloaded.push(url);
            return new Response(url.endsWith('/first.png') ? first : second, { headers: { 'content-type': 'image/png' } });
        }
        if (options.method === 'POST') {
            posts++;
            assert.equal(JSON.parse(options.body).prompt, body.prompt);
        }
        return json({ status: 'completed', data: [
            { url: 'https://fixture.test/first.png' }, { url: 'https://fixture.test/second.png' }
        ] });
    };
    const result = await bridge._generateImageFromRenderer(body);
    assert.equal(posts, 1);
    assert.ok(downloaded[0].endsWith('/second.png'));
    assert.deepEqual(result.filePaths.map(file => path.basename(file)), ['雨夜街道_图片_001.png', '雨夜街道_图片_002.png']);
    assert.deepEqual(result.images.map(image => image.width), [16, 8]);
    const recovered = await bridge._resumeImageFromRenderer({ ...body, taskId: 'fixture-task' });
    assert.equal(posts, 1, 'recovery and naming must never resubmit generation');
    assert.deepEqual(recovered.filePaths.map(file => path.basename(file)), ['雨夜街道_图片_003.png', '雨夜街道_图片_004.png']);
    assert.deepEqual(fs.readFileSync(result.filePaths[0]), first);
});

test('video generation and recovery share local naming without changing provider prompts or media bytes', { timeout: 10000 }, async t => {
    const { bridge, body } = setup(t);
    body.providerConfig.model = 'fixture-video';
    let posts = 0;
    const bytes = Buffer.from('fixture video bytes');
    fetchFixture = async (url, options = {}) => {
        assert.equal(new URL(url).hostname, 'fixture.test');
        if (url.endsWith('/output.mp4')) return new Response(bytes, { headers: { 'content-type': 'video/mp4' } });
        if (options.method === 'POST') {
            posts++;
            assert.equal(JSON.parse(options.body).prompt, body.prompt);
        }
        return json({ id: 'fixture-video-task', status: 'completed', video_url: 'https://fixture.test/output.mp4' });
    };
    const result = await bridge._generateVideoFromRenderer(body);
    assert.equal(path.basename(result.filePath), '雨夜街道_视频_001.mp4');
    const recovered = await bridge._resumeVideoFromRenderer({ ...body, taskId: 'fixture-video-task' });
    assert.equal(path.basename(recovered.filePath), '雨夜街道_视频_002.mp4');
    assert.equal(posts, 1);
    assert.deepEqual(fs.readFileSync(result.filePath), bytes);
});

test('Midjourney candidates retain U1-U4 suffixes on the readable grid filename', { timeout: 10000 }, async t => {
    const { bridge, body } = setup(t);
    body.providerConfig.model = 'mj_imagine';
    const grid = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#808080' } }).png().toBuffer();
    fetchFixture = async url => {
        assert.equal(new URL(url).hostname, 'fixture.test');
        return json({ status: 'completed', data: [{ b64_json: grid.toString('base64') }] });
    };
    const result = await bridge._resumeImageFromRenderer({ ...body, taskId: 'fixture-mj-task' });
    assert.deepEqual(result.filePaths.map(file => path.basename(file)),
        [1, 2, 3, 4].map(index => `雨夜街道_图片_001_U${index}.png`));
    assert.deepEqual(result.images.map(image => image.candidateIndex), [1, 2, 3, 4]);
});
