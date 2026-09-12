const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const sharp = require('sharp');

let profile;
let fetchFixture;
let Bridge;
const originalLoad = Module._load;
try {
    Module._load = function (name, ...args) {
        return name === 'electron' ? { app: { getPath: () => profile }, net: { fetch: (...args) => fetchFixture(...args) } }
            : originalLoad.call(this, name, ...args);
    };
    Bridge = require('./mcp-bridge');
} finally { Module._load = originalLoad; }

const mediaUrl = bytes => `https://hm-fixture.test/media/${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('HM 301010 transports all 50 references, preserves order and supports task-ID recovery', { timeout: 15000 }, async t => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-hm-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const bridge = new Bridge({ store: { load: () => ({ items: [] }) }, recoveryDirectory: path.join(profile, 'records') });
    bridge._loadWithPlanService = () => ({ data: { items: [] }, planService: {} });
    const body = { prompt: 'reference order fixture', duration: 4, ratio: '16:9', targetDir: profile, addToCanvas: false,
        providerConfig: { endpoint: 'https://hm-fixture.test/v1', model: 'seedance_v2.5-301010', apiKey: 'fixture-only',
            temporaryUploadEndpoint: 'https://hm-fixture.test/upload', temporaryUploadToken: 'fixture-only' } };
    const expected = {};
    for (const [field, count, ext, wire] of [['sourceReferences', 30, 'png', 'image_urls'],
        ['videoReferences', 10, 'mp4', 'video_urls'], ['audioReferences', 10, 'mp3', 'audio_urls']]) {
        body[field] = [];
        expected[wire] = [];
        for (let i = 0; i < count; i++) {
            const bytes = ext === 'png'
                ? await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: i, g: 80, b: 80 } } }).png().toBuffer()
                : Buffer.from(`${field}-${i}`);
            const filePath = path.join(profile, `${field}-${i}.${ext}`);
            fs.writeFileSync(filePath, bytes);
            body[field].push({ filePath });
            expected[wire].push(mediaUrl(bytes));
        }
    }
    let posts = 0;
    let uploads = 0;
    fetchFixture = async (url, options = {}) => {
        assert.equal(new URL(url).hostname, 'hm-fixture.test', 'mock must not use a live upstream');
        if (url.endsWith('/upload')) {
            const form = await new Response(options.body, { headers: options.headers }).formData();
            const bytes = Buffer.from(await form.get('file').arrayBuffer());
            uploads++;
            return json({ success: true, url: mediaUrl(bytes) });
        }
        if (url.endsWith('/output.mp4')) return new Response('fixture video');
        if (options.method === 'POST') {
            posts++;
            assert.equal(url, 'https://hm-fixture.test/v1/video/generations');
            assert.deepEqual(JSON.parse(options.body), { model: body.providerConfig.model, prompt: body.prompt,
                seconds: 4, ratio: '16:9', resolution: '720p', ...expected });
        } else assert.match(url, /fixture-task/);
        return json({ id: 'fixture-task', status: 'completed', video_url: 'https://hm-fixture.test/output.mp4' });
    };
    const generated = await bridge._generateVideoFromRenderer(body);
    assert.equal(uploads, 50);
    assert.equal(posts, 1);
    assert.ok(fs.existsSync(generated.filePath));
    await bridge._resumeVideoFromRenderer({ ...body, taskId: 'fixture-task' });
    assert.equal(posts, 1, 'recovery must not resubmit a billed request');
    for (const field of ['sourceReferences', 'videoReferences', 'audioReferences']) {
        const extraPath = path.join(profile, `extra-${field}${path.extname(body[field][0].filePath)}`);
        fs.copyFileSync(body[field][0].filePath, extraPath);
        await assert.rejects(() => bridge._generateVideoFromRenderer({ ...body,
            [field]: [...body[field], { filePath: extraPath }] }), /最多支持/);
    }
    assert.equal(posts, 1, 'over-limit input must not create another task');
});
