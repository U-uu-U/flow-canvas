import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_MODEL_CONFIG_URL,
    DEFAULT_REFRESH_INTERVAL_MS,
    MODEL_CONFIG_CACHE_KEY,
    MODEL_CONFIG_URL_KEY,
    createModelConfigStore,
    isAllowedConfigUrl,
    normalizeRefreshInterval,
    readModelConfig
} from './model-config.js';
import { DEFAULT_MODEL_CONFIG } from './model-config-default.js';

function createStorage(seed = {}) {
    const map = new Map(Object.entries(seed));
    return {
        getItem: key => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => { map.set(key, String(value)); },
        removeItem: key => { map.delete(key); },
        dump: () => Object.fromEntries(map)
    };
}

const remoteConfig = {
    schemaVersion: 1,
    revision: 42,
    updatedAt: '2026-09-11T10:00:00.000Z',
    source: 'test-server',
    models: [{
        id: 'test.model',
        label: 'test-model',
        kind: 'video',
        channel: '测试渠道',
        route: '测试线路',
        match: { model: ['^test-model$'] },
        parameters: { accepts: ['model', 'prompt'] },
        options: {},
        capabilities: {},
        prompt: { required: true }
    }]
};

test('默认更新源写死为 artconfig.ravenhash.org 的 /config', () => {
    // 回归守卫：这个地址是内置到客户端里的更新源，改动必须是有意的。
    assert.equal(DEFAULT_MODEL_CONFIG_URL, 'https://artconfig.ravenhash.org/config');
    assert.equal(isAllowedConfigUrl(DEFAULT_MODEL_CONFIG_URL), true);

    const store = createModelConfigStore({ storage: createStorage() });
    const status = store.getStatus();
    assert.equal(status.url, DEFAULT_MODEL_CONFIG_URL);
    assert.equal(status.urlConfigured, true);
    assert.equal(status.isDefaultUrl, true);
    // 启动时不需要网络就能用：默认配置已经生效，只是还没拉过远端
    assert.equal(status.origin, 'builtin');
    assert.equal(status.fetchedAt, null);
    assert.equal(status.modelCount, DEFAULT_MODEL_CONFIG.models.length);
    assert.equal(status.refreshIntervalMs, DEFAULT_REFRESH_INTERVAL_MS);
});

test('localStorage 里的地址覆盖默认源，清空则显式关闭远端更新', () => {
    // 记过自定义地址 → 用记录，且不再是默认源
    const custom = createModelConfigStore({ storage: createStorage({ [MODEL_CONFIG_URL_KEY]: 'https://cdn.example.com/c.json' }) });
    assert.equal(custom.getUrl(), 'https://cdn.example.com/c.json');
    assert.equal(custom.getStatus().isDefaultUrl, false);

    // 显式清空 → 不再拉取远端（URL 需要区分「没设过」和「设成空」）
    const disabled = createModelConfigStore({ storage: createStorage({ [MODEL_CONFIG_URL_KEY]: '' }) });
    assert.equal(disabled.getUrl(), '');
    assert.equal(disabled.getStatus().urlConfigured, false);
    assert.equal(disabled.isDue(), false);

    // 清空后重新构造也不该偷偷退回默认源（用户的意思就是关掉）
    const store = createModelConfigStore({ storage: createStorage() });
    store.setUrl('');
    assert.equal(store.getStatus().urlConfigured, false);
    assert.equal(createStorage({ [MODEL_CONFIG_URL_KEY]: '' }).getItem(MODEL_CONFIG_URL_KEY), '');
});

test('显式传入 url 时优先于默认源（测试与自建服务都用这个口子）', () => {
    const store = createModelConfigStore({ storage: createStorage(), url: 'http://127.0.0.1:9000/config' });
    assert.equal(store.getUrl(), 'http://127.0.0.1:9000/config');
    assert.equal(store.getStatus().isDefaultUrl, false);
});

test('地址只认 http(s)，不强制 https', () => {
    assert.equal(isAllowedConfigUrl('https://example.com/model-config.json'), true);
    assert.equal(isAllowedConfigUrl('http://example.com/config.json'), true);
    assert.equal(isAllowedConfigUrl('http://127.0.0.1:8087/config'), true);
    // 非 http(s) 协议与非法 URL 仍然拒绝
    assert.equal(isAllowedConfigUrl('file:///etc/passwd'), false);
    assert.equal(isAllowedConfigUrl('ftp://example.com/config.json'), false);
    assert.equal(isAllowedConfigUrl('not a url'), false);

    const store = createModelConfigStore({ storage: createStorage() });
    assert.equal(store.setUrl('http://example.com/config.json').ok, true);
    assert.equal(store.setUrl('file:///etc/passwd').ok, false);
    assert.equal(store.getUrl(), 'http://example.com/config.json');
});

test('拉取成功后切换到服务器配置并写入缓存', async () => {
    const storage = createStorage();
    const calls = [];
    const store = createModelConfigStore({
        storage,
        loadRemote: async ({ url }) => { calls.push(url); return { ok: true, raw: remoteConfig, fetchedAt: 111 }; }
    });
    store.setUrl('https://example.com/model-config.json');

    const changes = [];
    store.subscribe((config, status, reason) => changes.push(reason));

    const result = await store.refresh({ force: true });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.deepEqual(calls, ['https://example.com/model-config.json']);

    const status = store.getStatus();
    assert.equal(status.origin, 'remote');
    assert.equal(status.revision, 42);
    assert.equal(status.modelCount, 1);
    assert.equal(status.fetchedAt, 111);
    assert.equal(status.lastError, null);
    assert.ok(changes.includes('refresh'));

    const cached = JSON.parse(storage.dump()[MODEL_CONFIG_CACHE_KEY]);
    assert.equal(cached.url, 'https://example.com/model-config.json');
    assert.equal(cached.config.revision, 42);
    assert.equal(storage.dump()[MODEL_CONFIG_URL_KEY], 'https://example.com/model-config.json');
});

test('拉取失败时保留当前配置并记录错误', async () => {
    const store = createModelConfigStore({
        storage: createStorage(),
        loadRemote: async () => ({ ok: false, error: 'HTTP 500' })
    });
    store.setUrl('https://example.com/model-config.json');

    const result = await store.refresh({ force: true });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'HTTP 500');

    const status = store.getStatus();
    assert.equal(status.origin, 'builtin');
    assert.equal(status.lastError, 'HTTP 500');
    assert.ok(status.lastErrorAt > 0);
    assert.equal(status.modelCount, DEFAULT_MODEL_CONFIG.models.length);
});

test('服务器返回结构不可识别时整包丢弃', async () => {
    const store = createModelConfigStore({
        storage: createStorage(),
        loadRemote: async () => ({ ok: true, raw: { ...remoteConfig, schemaVersion: 99 }, fetchedAt: 1 })
    });
    store.setUrl('https://example.com/model-config.json');
    const result = await store.refresh({ force: true });
    assert.equal(result.ok, false);
    assert.match(store.getStatus().lastError, /结构无法识别/);
    assert.equal(store.getStatus().origin, 'builtin');
});

test('启动时先用缓存，过期也不会清空', () => {
    const storage = createStorage({
        [MODEL_CONFIG_URL_KEY]: 'https://example.com/model-config.json',
        [MODEL_CONFIG_CACHE_KEY]: JSON.stringify({
            version: 1,
            url: 'https://example.com/model-config.json',
            fetchedAt: 1,
            config: remoteConfig
        })
    });
    const store = createModelConfigStore({
        storage,
        now: () => 10 * 60 * 60 * 1000,
        loadRemote: async () => ({ ok: false, error: 'offline' }),
        setIntervalImpl: () => null
    });
    store.start();
    const status = store.getStatus();
    assert.equal(status.origin, 'cache');
    assert.equal(status.revision, 42);
    assert.equal(status.stale, true);
    store.stop();
});

test('并发刷新只请求一次，且 1 小时内不重复自动拉取', async () => {
    let calls = 0;
    let clock = 1000;
    const store = createModelConfigStore({
        storage: createStorage(),
        now: () => clock,
        loadRemote: async () => { calls += 1; return { ok: true, raw: remoteConfig, fetchedAt: clock }; }
    });
    store.setUrl('https://example.com/model-config.json');

    const [first, second] = await Promise.all([store.refresh({ force: true }), store.refresh({ force: true })]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(calls, 1);

    assert.equal(store.isDue(), false);
    const skipped = await store.refresh();
    assert.equal(skipped.skipped, true);
    assert.equal(calls, 1);

    clock += DEFAULT_REFRESH_INTERVAL_MS + 1;
    assert.equal(store.isDue(), true);
    await store.refresh();
    assert.equal(calls, 2);
});

test('config 里的 refreshIntervalMs 可覆盖刷新周期并带上下限', () => {
    assert.equal(normalizeRefreshInterval(120000), 5 * 60 * 1000);
    assert.equal(normalizeRefreshInterval(999999999), 24 * 60 * 60 * 1000);
    assert.equal(normalizeRefreshInterval(undefined), DEFAULT_REFRESH_INTERVAL_MS);
    assert.equal(normalizeRefreshInterval('abc'), DEFAULT_REFRESH_INTERVAL_MS);
});

test('reset 清空缓存并回到内置默认配置', async () => {
    const storage = createStorage();
    const store = createModelConfigStore({
        storage,
        loadRemote: async () => ({ ok: true, raw: remoteConfig, fetchedAt: 5 })
    });
    store.setUrl('https://example.com/model-config.json');
    await store.refresh({ force: true });
    assert.equal(store.getStatus().origin, 'remote');

    const status = store.reset();
    assert.equal(status.origin, 'builtin');
    assert.equal(status.fetchedAt, null);
    assert.equal(storage.dump()[MODEL_CONFIG_CACHE_KEY], undefined);
    assert.equal(storage.dump()[MODEL_CONFIG_URL_KEY], 'https://example.com/model-config.json');
});

test('readModelConfig 丢弃损坏条目但保留可用条目', () => {
    const sanitized = readModelConfig({
        schemaVersion: 1,
        revision: 3,
        models: [
            remoteConfig.models[0],
            { id: 'broken', kind: 'video', match: { model: ['('] } },
            { id: 'bad-kind', kind: 'audio', match: { model: ['x'] } },
            remoteConfig.models[0]
        ]
    });
    assert.equal(sanitized.models.length, 1);
    assert.equal(sanitized.models[0].id, 'test.model');
    assert.equal(readModelConfig({ schemaVersion: 2, models: [] }), null);
    assert.equal(readModelConfig({ schemaVersion: 1, models: [] }), null);
    assert.equal(readModelConfig(null), null);
});
