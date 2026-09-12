// 模型能力 CONFIG 的客户端加载器。
//
// 职责链：内置默认（永远可用）→ 本地缓存（上次成功拉取）→ 服务器（每 1 小时 / 手动刷新）。
// 三层永远有一层能用，所以 UI 不会因为「配置还没到」而空转；拉取失败只记录状态，
// 绝不覆盖已经可用的配置。
//
// 网络请求走主进程 IPC（electron-main/model-config-service.cjs）：仓库既有约定是渲染层不发
// 请求（所有网络都在主进程用 net.fetch），而且这样能顺带绕开 file:// 源下的 CORS，
// 并且由主进程用 shared/schemas/model-config.schema.json 做完整 schema 校验——远端 JSON 是
// 不可信输入，宁可整包丢弃也不能让坏数据进入 UI。这里只做一层廉价的结构兜底。
import { DEFAULT_MODEL_CONFIG } from './model-config-default.js';

export const MODEL_CONFIG_CACHE_KEY = 'flow-canvas-model-config-v1';
export const MODEL_CONFIG_URL_KEY = 'flow-canvas-model-config-url-v1';
// 内置更新源：写死的线上地址（artconfig.ravenhash.org 的 /config 只读接口）。
// 首次启动、以及用户从未改过地址时都用它；在设置里清空地址可显式关闭远端更新。
export const DEFAULT_MODEL_CONFIG_URL = 'https://artconfig.ravenhash.org/config';
export const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MODEL_CONFIG_SCHEMA_VERSION = 1;

// 到期检查的心跳。用「每分钟醒来判断是否到期」而不是「setInterval(1 小时)」：
// Electron 在窗口隐藏/最小化时会把长定时器降频甚至挂起，长间隔定时器会漂移。
const DUE_CHECK_INTERVAL_MS = 60 * 1000;

export const MODEL_CONFIG_ORIGINS = Object.freeze({
    BUILTIN: 'builtin',
    CACHE: 'cache',
    REMOTE: 'remote'
});

const ORIGIN_LABELS = Object.freeze({
    builtin: '内置默认配置',
    cache: '本地缓存',
    remote: '服务器'
});

const VALID_KINDS = ['image', 'video', 'text'];
// Retired, unconnected templates must not return through an older remote config.
const RETIRED_TEMPLATE_IDS = new Set([
    'video-template.seedance-1.5', 'video-template.wan',
    'video-template.kling', 'video-template.tencent-vidu'
]);

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function compileMatchSources(model) {
    const sources = Array.isArray(model?.match?.model) ? model.match.model : [];
    const usable = [];
    for (const source of sources) {
        if (typeof source !== 'string' || !source.trim()) continue;
        try {
            new RegExp(source, 'i');
            usable.push(source);
        } catch (_) {
            // 非法正则只丢弃这一条别名，不让整个条目失效。
        }
    }
    return usable;
}

// 渲染层兜底校验：主进程已经用 ajv 校验过，这里只保证「拿到的东西至少是我们认识的结构」。
// 单条损坏只丢该条；整体不可用返回 null，调用方保持当前配置不变。
export function readModelConfig(raw) {
    if (!isPlainObject(raw)) return null;
    if (Number(raw.schemaVersion) !== MODEL_CONFIG_SCHEMA_VERSION) return null;
    if (!Array.isArray(raw.models)) return null;
    const seen = new Set();
    const models = [];
    for (const entry of raw.models) {
        if (!isPlainObject(entry)) continue;
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        const kind = VALID_KINDS.includes(entry.kind) ? entry.kind : '';
        if (!id || !kind || seen.has(id) || RETIRED_TEMPLATE_IDS.has(id)) continue;
        const matchSources = compileMatchSources(entry);
        if (!matchSources.length) continue;
        seen.add(id);
        models.push({
            ...entry,
            id,
            kind,
            label: typeof entry.label === 'string' ? entry.label : id,
            match: { ...entry.match, model: matchSources },
            parameters: isPlainObject(entry.parameters) ? entry.parameters : {},
            options: isPlainObject(entry.options) ? entry.options : {},
            capabilities: isPlainObject(entry.capabilities) ? entry.capabilities : {},
            prompt: isPlainObject(entry.prompt) ? entry.prompt : {},
            limits: isPlainObject(entry.limits) ? entry.limits : {}
        });
    }
    if (!models.length) return null;
    return {
        schemaVersion: MODEL_CONFIG_SCHEMA_VERSION,
        revision: Number.isFinite(Number(raw.revision)) ? Number(raw.revision) : 0,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
        source: typeof raw.source === 'string' ? raw.source : '',
        refreshIntervalMs: normalizeRefreshInterval(raw.refreshIntervalMs),
        kinds: isPlainObject(raw.kinds) ? { ...raw.kinds } : {},
        fields: isPlainObject(raw.fields) ? { ...raw.fields } : {},
        capabilities: isPlainObject(raw.capabilities) ? { ...raw.capabilities } : {},
        models
    };
}

export function normalizeRefreshInterval(value) {
    const interval = Number(value);
    if (!Number.isFinite(interval) || interval <= 0) return DEFAULT_REFRESH_INTERVAL_MS;
    return Math.min(MAX_REFRESH_INTERVAL_MS, Math.max(MIN_REFRESH_INTERVAL_MS, Math.round(interval)));
}

function normalizeUrl(value) {
    return String(value || '').trim();
}

// 只校验「是不是一个可用的 http(s) URL」：协议强制交给部署方（反代 / 内网直连都行），
// 客户端不做 https 强制。其它协议（file:、ftp: 等）一律拒绝。
export function isAllowedConfigUrl(value) {
    const url = normalizeUrl(value);
    if (!url) return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch (_) {
        return false;
    }
}

async function defaultRemoteLoader({ url }) {
    const bridge = globalThis.window?.flowCanvas?.modelConfig;
    if (!bridge || typeof bridge.fetch !== 'function') {
        return { ok: false, error: '本地配置接口不可用（preload 未加载）' };
    }
    try {
        const result = await bridge.fetch({ url });
        if (!result || result.success !== true) {
            return { ok: false, error: String(result?.error || '服务器未返回配置') };
        }
        return { ok: true, raw: result.config, fetchedAt: Date.now(), httpStatus: result.status };
    } catch (error) {
        return { ok: false, error: error?.message ? String(error.message) : String(error) };
    }
}

export function createModelConfigStore(options = {}) {
    const storage = options.storage === undefined ? globalThis.localStorage : options.storage;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const loadRemote = typeof options.loadRemote === 'function' ? options.loadRemote : defaultRemoteLoader;
    const windowRef = options.windowRef === undefined ? globalThis.window : options.windowRef;
    const setIntervalImpl = options.setIntervalImpl || ((handler, ms) => setInterval(handler, ms));
    const clearIntervalImpl = options.clearIntervalImpl || (handle => clearInterval(handle));

    const listeners = new Set();
    // 地址三态：options.url 显式给了就用它；localStorage 里有记录就用记录（空串 = 用户主动
    // 关闭远端更新）；从未设置过则落到内置的 artconfig.ravenhash.org。
    const initialUrl = options.url !== undefined
        ? normalizeUrl(options.url)
        : (() => {
            const stored = readUrlValue();
            return stored === null ? DEFAULT_MODEL_CONFIG_URL : normalizeUrl(stored);
        })();
    const state = {
        config: readModelConfig(DEFAULT_MODEL_CONFIG) || DEFAULT_MODEL_CONFIG,
        origin: MODEL_CONFIG_ORIGINS.BUILTIN,
        url: initialUrl,
        fetchedAt: null,
        lastError: null,
        lastErrorAt: null,
        lastAttemptAt: null,
        refreshing: false,
        started: false,
        ticker: null,
        focusHandler: null,
        inflight: null
    };

    function readStoredValue(target, key) {
        try {
            return target?.getItem(key) || '';
        } catch (_) {
            return '';
        }
    }

    // 地址需要区分「从未设置」（null → 用内置默认）与「显式清空」（'' → 关闭远端更新），
    // 所以不像其它键那样把空串当成删除。
    function readUrlValue() {
        try {
            const value = storage?.getItem(MODEL_CONFIG_URL_KEY);
            return value === null || value === undefined ? null : String(value);
        } catch (_) {
            return null;
        }
    }

    function writeUrlValue(value) {
        try {
            storage?.setItem(MODEL_CONFIG_URL_KEY, String(value ?? ''));
        } catch (_) {
            // localStorage 不可用时只影响持久化，不影响本次会话。
        }
    }

    function writeStoredValue(target, key, value) {
        try {
            if (value === null || value === undefined || value === '') target?.removeItem?.(key);
            else target?.setItem(key, value);
        } catch (_) {
            // localStorage 满/被禁用时静默降级：配置仍可以在内存里用。
        }
    }

    function readCache() {
        try {
            const raw = JSON.parse(readStoredValue(storage, MODEL_CONFIG_CACHE_KEY) || 'null');
            if (!isPlainObject(raw)) return null;
            const config = readModelConfig(raw.config);
            if (!config) return null;
            return {
                config,
                url: normalizeUrl(raw.url),
                fetchedAt: Number.isFinite(Number(raw.fetchedAt)) ? Number(raw.fetchedAt) : null
            };
        } catch (_) {
            return null;
        }
    }

    function writeCache(config, url, fetchedAt) {
        writeStoredValue(storage, MODEL_CONFIG_CACHE_KEY, JSON.stringify({
            version: MODEL_CONFIG_SCHEMA_VERSION,
            url,
            fetchedAt,
            config
        }));
    }

    function refreshIntervalMs() {
        return normalizeRefreshInterval(state.config?.refreshIntervalMs);
    }

    function emit(reason) {
        const status = getStatus();
        for (const listener of [...listeners]) {
            try {
                listener(state.config, status, reason);
            } catch (error) {
                console.error('[ModelConfig] 订阅回调失败:', error);
            }
        }
    }

    function applyConfig(config, origin, { fetchedAt = null, reason = 'apply' } = {}) {
        const changed = !sameConfig(state.config, config) || state.origin !== origin;
        state.config = config;
        state.origin = origin;
        if (fetchedAt !== null) state.fetchedAt = fetchedAt;
        if (changed) emit(reason);
        return changed;
    }

    function sameConfig(left, right) {
        if (left === right) return true;
        try {
            return JSON.stringify(left) === JSON.stringify(right);
        } catch (_) {
            return false;
        }
    }

    function getConfig() {
        return state.config;
    }

    function getStatus() {
        const fetchedAt = state.fetchedAt;
        const interval = refreshIntervalMs();
        return {
            origin: state.origin,
            originLabel: ORIGIN_LABELS[state.origin] || state.origin,
            url: state.url,
            urlConfigured: Boolean(state.url),
            isDefaultUrl: state.url === DEFAULT_MODEL_CONFIG_URL,
            revision: Number(state.config?.revision || 0),
            updatedAt: state.config?.updatedAt || '',
            source: state.config?.source || '',
            modelCount: Array.isArray(state.config?.models) ? state.config.models.length : 0,
            fetchedAt,
            refreshIntervalMs: interval,
            stale: fetchedAt === null ? true : (now() - fetchedAt) > interval,
            refreshing: state.refreshing,
            lastError: state.lastError,
            lastErrorAt: state.lastErrorAt,
            lastAttemptAt: state.lastAttemptAt,
            nextRefreshAt: state.url ? (state.lastAttemptAt || now()) + interval : null
        };
    }

    function getUrl() {
        return state.url;
    }

    function setUrl(value) {
        const url = normalizeUrl(value);
        if (url && !isAllowedConfigUrl(url)) {
            return { ok: false, error: '地址必须是 http:// 或 https:// 开头的 URL' };
        }
        const changed = url !== state.url;
        state.url = url;
        writeUrlValue(url);
        if (changed) {
            state.lastError = null;
            state.lastErrorAt = null;
            emit('url');
        }
        return { ok: true, url, changed };
    }

    async function refresh({ reason = 'manual', force = false } = {}) {
        if (!state.url) {
            state.lastError = '未配置服务器地址，正在使用内置默认配置';
            state.lastErrorAt = now();
            emit('refresh-skipped');
            return { ok: false, error: state.lastError, skipped: true };
        }
        if (state.inflight) return state.inflight;
        if (!force && !isDue()) {
            return { ok: false, skipped: true, error: '尚未到刷新时间' };
        }

        state.refreshing = true;
        state.lastAttemptAt = now();
        emit('refresh-start');

        state.inflight = (async () => {
            let result;
            try {
                result = await loadRemote({ url: state.url });
            } catch (error) {
                result = { ok: false, error: error?.message ? String(error.message) : String(error) };
            }

            if (result?.ok) {
                const config = readModelConfig(result.raw);
                if (!config) {
                    state.lastError = '服务器返回的配置结构无法识别，已继续使用当前配置';
                    state.lastErrorAt = now();
                    return { ok: false, error: state.lastError };
                }
                const fetchedAt = Number(result.fetchedAt) || now();
                writeCache(config, state.url, fetchedAt);
                state.lastError = null;
                state.lastErrorAt = null;
                const changed = applyConfig(config, MODEL_CONFIG_ORIGINS.REMOTE, { fetchedAt, reason: 'refresh' });
                return { ok: true, changed, revision: config.revision };
            }

            state.lastError = String(result?.error || '拉取失败');
            state.lastErrorAt = now();
            return { ok: false, error: state.lastError };
        })();

        try {
            return await state.inflight;
        } finally {
            state.inflight = null;
            state.refreshing = false;
            emit('refresh-end');
        }
    }

    function isDue() {
        if (!state.url) return false;
        if (state.fetchedAt === null) return true;
        return (now() - state.fetchedAt) >= refreshIntervalMs();
    }

    function checkDue() {
        if (isDue()) refresh({ reason: 'auto' });
    }

    function start({ refreshOnStart = true } = {}) {
        if (state.started) return getStatus();
        state.started = true;

        const cache = readCache();
        if (cache?.config) {
            // 缓存里的 fetchedAt 决定它是否过期；过期也先顶上，然后立刻去拉新的。
            applyConfig(cache.config, MODEL_CONFIG_ORIGINS.CACHE, { fetchedAt: cache.fetchedAt, reason: 'cache' });
        }

        state.ticker = setIntervalImpl(checkDue, DUE_CHECK_INTERVAL_MS);
        state.ticker?.unref?.();

        if (windowRef?.addEventListener) {
            state.focusHandler = () => checkDue();
            windowRef.addEventListener('focus', state.focusHandler);
        }

        if (refreshOnStart && state.url) checkDue();
        return getStatus();
    }

    function stop() {
        if (state.ticker !== null) clearIntervalImpl(state.ticker);
        state.ticker = null;
        if (state.focusHandler && windowRef?.removeEventListener) {
            windowRef.removeEventListener('focus', state.focusHandler);
        }
        state.focusHandler = null;
        state.started = false;
    }

    function reset() {
        writeStoredValue(storage, MODEL_CONFIG_CACHE_KEY, '');
        state.fetchedAt = null;
        state.lastError = null;
        state.lastErrorAt = null;
        applyConfig(readModelConfig(DEFAULT_MODEL_CONFIG), MODEL_CONFIG_ORIGINS.BUILTIN, { reason: 'reset' });
        return getStatus();
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    return {
        getConfig,
        getStatus,
        getUrl,
        setUrl,
        refresh,
        isDue,
        checkDue,
        start,
        stop,
        reset,
        subscribe,
        isAllowedConfigUrl
    };
}

export const modelConfigStore = createModelConfigStore();

if (typeof window !== 'undefined') {
    window.__flowCanvasGetModelConfigSnapshot = () => ({
        config: modelConfigStore.getConfig(), status: modelConfigStore.getStatus()
    });
}
