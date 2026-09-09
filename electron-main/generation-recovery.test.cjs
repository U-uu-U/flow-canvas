const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { GenerationRecoveryStore } = require('./generation-recovery-store.cjs');
const Bridge = require('./mcp-bridge');

function setup(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-recovery-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const bridge = new Bridge({ store: { load: () => ({ activeGroupId: 'original' }) },
        recoveryDirectory: path.join(directory, 'records') });
    bridge.attachRecoveredGeneration = async () => ({ nodeId: 'node', projectId: 'original' });
    const body = bridge._rememberGeneration('image', { clientTaskId: 'local', nodeId: 'node',
        prompt: 'two images', quality: 'high', size: '2048x2048', sourceReferences: [{ filePath: 'reference.png' }],
        providerConfig: { id: 'api', endpoint: 'https://original.test/v1', model: 'mj', apiKey: 'secret' } });
    bridge._rememberSubmitted(body, { remoteTaskId: 'remote', model: 'mj', targetDir: directory, location: '/v1/custom/remote' });
    return { bridge, directory, body: { ...body, kind: 'image', taskId: 'remote' } };
}

test('journal survives restart, preserves Location and never saves API keys', t => {
    const { bridge, body, directory } = setup(t);
    const restored = new GenerationRecoveryStore(path.join(directory, 'records'));
    assert.equal(restored.get(body.clientTaskId).taskId, 'remote');
    assert.equal(restored.get(body.clientTaskId).location, '/v1/custom/remote');
    assert.equal(JSON.stringify(restored.list()).includes('secret'), false);
    assert.equal(bridge.recoveryStore.get('local').projectId, 'original');
    assert.equal(restored.get('local').params.quality, 'high');
    assert.deepEqual(restored.get('local').sourcePaths, ['reference.png']);
});

test('immediate recovery after cancel uses original route and never submits generation', async t => {
    const { bridge, body, directory } = setup(t);
    bridge.cancelGenerationFromRenderer('local');
    let queries = 0;
    bridge.generateImageFromRenderer = () => assert.fail('must not submit');
    bridge._resumeImageFromRenderer = async request => {
        queries++;
        assert.equal(request.providerConfig.endpoint, 'https://original.test/v1');
        assert.equal(request.location, '/v1/custom/remote');
        assert.equal(request.projectId, 'original');
        const filePath = path.join(directory, 'result.png');
        fs.writeFileSync(filePath, 'test');
        return { filePath, filePaths: [filePath], taskId: request.taskId };
    };
    const request = { ...body, providerConfig: { ...body.providerConfig, endpoint: 'https://changed.test/v1' } };
    const result = await bridge.recoverGenerationFromRenderer(request);
    assert.equal(result.recovered, true);
    await bridge.recoverGenerationFromRenderer(request);
    assert.equal(queries, 1);
});

test('concurrent recovery shares one query; all four MJ results are retained', async t => {
    const { bridge, body, directory } = setup(t);
    let release, queries = 0;
    bridge._resumeImageFromRenderer = () => {
        queries++;
        return new Promise(resolve => { release = resolve; });
    };
    const first = bridge.recoverGenerationFromRenderer(body);
    const second = bridge.recoverGenerationFromRenderer(body);
    const files = [1, 2, 3, 4].map(i => {
        const file = path.join(directory, `${i}.png`);
        fs.writeFileSync(file, 'test'); return file;
    });
    release({ filePath: files[0], filePaths: files, taskId: 'remote' });
    assert.equal((await first).filePaths.length, 4);
    assert.deepEqual(await second, await first);
    assert.equal(queries, 1);
});

test('stopping recovery blocks a late result from attaching and permits immediate next recovery', async t => {
    const { bridge, body, directory } = setup(t);
    let release, attachments = 0;
    bridge.attachRecoveredGeneration = async () => { attachments++; return { nodeId: 'node' }; };
    bridge._resumeImageFromRenderer = () => new Promise(resolve => { release = resolve; });
    const pending = bridge.recoverGenerationFromRenderer(body);
    bridge.cancelGenerationFromRenderer('local');
    const filePath = path.join(directory, 'late.png');
    fs.writeFileSync(filePath, 'test');
    release({ filePath, filePaths: [filePath], taskId: 'remote' });
    await assert.rejects(pending, error => error.code === 'GENERATION_CANCELED');
    assert.equal(attachments, 0);
    await bridge.recoverGenerationFromRenderer(body);
    assert.equal(attachments, 1);
});

test('manual ID replacement does not reuse the previous task output', async t => {
    const { bridge, body, directory } = setup(t);
    const filePath = path.join(directory, 'old.png');
    fs.writeFileSync(filePath, 'old');
    bridge._rememberResult(body, { filePath, filePaths: [filePath], taskId: 'remote' });
    bridge._resumeImageFromRenderer = async request => {
        assert.equal(request.taskId, 'new-id');
        assert.equal(request.location, null);
        throw new Error('not available yet');
    };
    await assert.rejects(bridge.recoverGenerationFromRenderer({ ...body, taskId: 'new-id' }), /not available/);
    assert.equal(bridge.recoveryStore.get('local').result, null);
});

function response(status, payload) {
    return { response: { status, ok: status >= 200 && status < 300, headers: new Headers({ 'content-type': 'application/json' }) },
        text: typeof payload === 'string' ? payload : JSON.stringify(payload) };
}

for (const kind of ['image', 'video']) {
    test(`${kind} polling tolerates 502, invalid JSON, and delayed completed output using only GET`, async () => {
        const replies = [response(502, 'bad gateway'), response(200, '<html>busy</html>'),
            response(200, { status: 'completed' }), response(200, kind === 'image'
                ? { status: 'completed', data: [{ url: 'https://cdn.test/output.png' }] }
                : { status: 'completed', video_url: 'https://cdn.test/output.mp4' })];
        let requests = 0;
        const result = await Bridge[kind === 'image' ? 'pollOpenAiImageTask' : 'pollOpenAiVideoTask'](
            `https://api.test/v1/${kind === 'image' ? 'images' : 'video'}/generations`, 'key', 'remote',
            { status: 'pending', recovering: true }, { wait: async () => {}, fetchTask: async (_url, options) => {
                requests++; assert.equal(options.method, 'GET');
                assert.ok(replies.length, 'polling must terminate with available output');
                return replies.shift();
            } });
        assert.equal(result.taskId, 'remote');
        assert.equal(requests, 4);
    });
    test(`${kind} authentication failure is explicit and not retried`, async () => {
        let requests = 0;
        await assert.rejects(Bridge[kind === 'image' ? 'pollOpenAiImageTask' : 'pollOpenAiVideoTask'](
            'https://api.test/v1/images/generations', 'key', 'remote', { status: 'pending' },
            { wait: async () => {}, fetchTask: async () => { requests++; return response(401, 'bad key'); } }), /401/);
        assert.equal(requests, 1);
    });
}

test('image polling falls back from missing standard route to generic task route', async () => {
    const urls = [];
    await Bridge.pollOpenAiImageTask('https://api.test/v1/images/generations', 'key', 'remote', {},
        { wait: async () => {}, fetchTask: async url => {
            urls.push(url);
            return urls.length === 1 ? response(404, 'missing') : response(200, { data: [{ url: 'https://cdn.test/a.png' }] });
        } });
    assert.deepEqual(urls, ['https://api.test/v1/images/generations/remote', 'https://api.test/v1/tasks/remote']);
});
