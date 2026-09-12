const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    fetchModelConfig,
    createEffectiveModelConfigReader,
    isAllowedModelConfigUrl,
    validateModelConfig
} = require('./model-config-service.cjs');

const validConfig = {
    schemaVersion: 1,
    revision: 7,
    models: [{
        id: 'x.y',
        kind: 'video',
        match: { model: ['^y$'] },
        parameters: { accepts: ['model', 'prompt'] }
    }]
};

const fakeResponse = (body, { ok = true, status = 200 } = {}) => ({
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});

test('地址只认 http(s) 协议，不强制 https', () => {
    assert.equal(isAllowedModelConfigUrl('https://cdn.example.com/model-config.json'), true);
    assert.equal(isAllowedModelConfigUrl('http://cdn.example.com/model-config.json'), true);
    assert.equal(isAllowedModelConfigUrl('http://127.0.0.1:8087/config'), true);
    assert.equal(isAllowedModelConfigUrl('file:///c:/windows/win.ini'), false);
    assert.equal(isAllowedModelConfigUrl('ftp://cdn.example.com/config.json'), false);
    assert.equal(isAllowedModelConfigUrl(''), false);
});

test('validateModelConfig 用 schema 判定，纯函数可单测', () => {
    assert.deepEqual(validateModelConfig(validConfig), { ok: true, errors: [] });
    const invalid = validateModelConfig({ schemaVersion: 1, models: [{ id: 'x', kind: 'video' }] });
    assert.equal(invalid.ok, false);
    assert.ok(invalid.errors.length >= 1);
    assert.deepEqual(validateModelConfig({ models: [] }).ok, false);
});

test('拉取成功返回校验过的配置，并带上 HTTP 状态', async () => {
    const result = await fetchModelConfig({
        url: 'https://cdn.example.com/model-config.json',
        fetchImpl: async (url, init) => {
            assert.equal(url, 'https://cdn.example.com/model-config.json');
            assert.equal(init.method, 'GET');
            assert.ok(init.signal, '必须带 AbortSignal 以支持超时');
            return fakeResponse(validConfig);
        }
    });
    assert.equal(result.success, true);
    assert.equal(result.status, 200);
    assert.equal(result.config.revision, 7);
});

test('HTTP 非 2xx、坏 JSON、schema 不通过都被拒绝且带可读原因', async () => {
    const notFound = await fetchModelConfig({
        url: 'https://cdn.example.com/x.json',
        fetchImpl: async () => fakeResponse({}, { ok: false, status: 404 })
    });
    assert.equal(notFound.success, false);
    assert.match(notFound.error, /HTTP 404/);

    const badJson = await fetchModelConfig({
        url: 'https://cdn.example.com/x.json',
        fetchImpl: async () => fakeResponse('<html>not json</html>')
    });
    assert.equal(badJson.success, false);
    assert.match(badJson.error, /不是合法 JSON/);

    const badSchema = await fetchModelConfig({
        url: 'https://cdn.example.com/x.json',
        fetchImpl: async () => fakeResponse({ schemaVersion: 1, models: [{ id: 'a', kind: 'audio' }] })
    });
    assert.equal(badSchema.success, false);
    assert.match(badSchema.error, /schema 校验/);
    assert.ok(Array.isArray(badSchema.details) && badSchema.details.length >= 1);
});

test('非 http(s) 协议在发请求之前就被拦下', async () => {
    let called = 0;
    const result = await fetchModelConfig({
        url: 'file:///etc/passwd',
        fetchImpl: async () => { called += 1; return fakeResponse(validConfig); }
    });
    assert.equal(result.success, false);
    assert.equal(called, 0);
    assert.match(result.error, /http:\/\/ 或 https:\/\//);
});

test('超时映射成可读错误而不是抛异常', async () => {
    const result = await fetchModelConfig({
        url: 'https://cdn.example.com/x.json',
        timeoutMs: 1000,
        fetchImpl: async () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
        }
    });
    assert.equal(result.success, false);
    assert.match(result.error, /超时/);
});

test('schema 文件本身是合法 JSON 且包含 models 定义', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'schemas', 'model-config.schema.json'), 'utf8'));
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties.models);
    assert.ok(schema.definitions.model);
});

test('effective reader follows the renderer cache, remote apply, URL switch and builtin reset', async t => {
    const { createModelConfigStore, readModelConfig, MODEL_CONFIG_CACHE_KEY, MODEL_CONFIG_URL_KEY } = await import('../src/model-config.js');
    const { DEFAULT_MODEL_CONFIG } = await import('../src/model-config-default.js');
    const storage = new Map([
        [MODEL_CONFIG_URL_KEY, 'https://old.example/config'],
        [MODEL_CONFIG_CACHE_KEY, JSON.stringify({ config: validConfig, url: 'https://old.example/config', fetchedAt: 123 })]
    ]);
    let response = { ok: true, raw: { ...validConfig, revision: 8 }, fetchedAt: 234 };
    const store = createModelConfigStore({ storage: {
        getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)
    }, windowRef: null, loadRemote: async () => response });
    store.start({ refreshOnStart: false });
    t.after(() => store.stop());
    const window = { isDestroyed: () => false, webContents: { executeJavaScript: async code =>
        require('node:vm').runInNewContext(code, {
            __flowCanvasGetModelConfigSnapshot: () => ({ config: store.getConfig(), status: store.getStatus() })
        }) } };
    const read = createEffectiveModelConfigReader({ getMainWindow: () => window });
    assert.equal((await read()).revision, 7);
    await store.refresh({ force: true });
    assert.equal((await read()).revision, 8);
    assert.equal(JSON.parse(storage.get(MODEL_CONFIG_CACHE_KEY)).config.revision, 8);
    store.setUrl('https://new.example/config');
    assert.deepEqual(await read(), store.getConfig(), 'URL selection alone must not activate a different config');
    response = { ok: false, error: 'offline' };
    await store.refresh({ force: true });
    assert.equal((await read()).revision, 8);
    store.setUrl('');
    assert.equal((await read()).revision, 8, 'disabling updates retains the actually applied cache');
    store.reset();
    assert.deepEqual(await read(), readModelConfig(DEFAULT_MODEL_CONFIG));
    assert.equal(storage.has(MODEL_CONFIG_CACHE_KEY), false);
    const isolated = await read();
    isolated.models[0].options = {};
    assert.deepEqual(await read(), store.getConfig(), 'Agent cannot mutate renderer CONFIG');
});

test('fetching a verified CONFIG does not activate it ahead of the renderer', async () => {
    const window = { isDestroyed: () => false, webContents: { executeJavaScript: async () => ({ config: validConfig }) } };
    const read = createEffectiveModelConfigReader({ getMainWindow: () => window });
    const response = await fetchModelConfig({ url: 'https://example.invalid/config',
        fetchImpl: async () => fakeResponse({ ...validConfig, revision: 999 }) });
    assert.equal(response.config.revision, 999);
    assert.equal((await read()).revision, 7);
});

test('unavailable or invalid live stores never silently revert Agent to builtin CONFIG', async () => {
    let snapshot = null;
    let window = { isDestroyed: () => false, webContents: { executeJavaScript: async () => snapshot } };
    const read = createEffectiveModelConfigReader({ getMainWindow: () => window });
    await assert.rejects(read(), { code: 'MODEL_CONFIG_UNAVAILABLE' });
    snapshot = { config: validConfig };
    assert.equal((await read()).revision, 7);
    snapshot = { config: { schemaVersion: 1, models: [] } };
    await assert.rejects(read(), { code: 'MODEL_CONFIG_UNAVAILABLE' });
    window = null;
    await assert.rejects(read(), { code: 'MODEL_CONFIG_UNAVAILABLE' });
});

test('a renderer replaced during snapshot acquisition cannot supply a stale CONFIG', async () => {
    let current = { isDestroyed: () => false, webContents: { executeJavaScript: async () => {
        current = { isDestroyed: () => false };
        return { config: validConfig };
    } } };
    await assert.rejects(createEffectiveModelConfigReader({ getMainWindow: () => current })(), { code: 'MODEL_CONFIG_UNAVAILABLE' });
});
