// 模型能力 CONFIG 的远端拉取与 schema 校验（主进程）。
//
// 为什么放在主进程：
//   · 仓库既有约定是渲染层不发网络请求，全部走 IPC + `net.fetch`（渲染层 grep `fetch(` 为零）；
//   · 生产环境渲染层是 file:// 源，直接 fetch 会被 CORS 挡住（Origin: null），主进程没有这个限制；
//   · 远端 JSON 是不可信输入，必须在进入渲染层之前用 shared/schemas/model-config.schema.json
//     严格校验。整包校验失败就整包丢弃，让渲染层继续用缓存/内置默认，绝不部分采用。
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_PATH = path.join(__dirname, '..', 'shared', 'schemas', 'model-config.schema.json');
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BYTES = 2 * 1024 * 1024;

let cachedValidator = null;

// 只校验协议是不是 http(s)：不强制 https（反代与内网直连由部署方决定）。
function isAllowedModelConfigUrl(value) {
    const url = String(value || '').trim();
    if (!url) return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch (_) {
        return false;
    }
}

function getValidator() {
    if (cachedValidator) return cachedValidator;
    const Ajv = require('ajv');
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    cachedValidator = new Ajv({ allErrors: true }).compile(schema);
    return cachedValidator;
}

function formatAjvError(error) {
    const where = error.dataPath || '';
    if (where === '' && error.keyword === 'required' && error.params?.missingProperty === 'models') {
        return '缺少 models 数组';
    }
    return `${where || '/'} ${error.message}`;
}

// 校验一份 CONFIG。返回 { ok, errors }。纯函数，便于单测。
function validateModelConfig(config) {
    let validate;
    try {
        validate = getValidator();
    } catch (error) {
        return { ok: false, errors: [`schema 加载失败：${error.message}`] };
    }
    if (validate(config)) return { ok: true, errors: [] };
    return { ok: false, errors: (validate.errors || []).map(formatAjvError) };
}

/**
 * 拉取并校验远端 CONFIG。
 *
 * @param {object} options
 * @param {string} options.url
 * @param {Function} options.fetchImpl  取 `net.fetch`（测试可注入）
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{success:boolean, config?:object, status?:number, error?:string, details?:string[]}>}
 */
async function fetchModelConfig({ url, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const target = String(url || '').trim();
    if (!target) return { success: false, error: '未配置 CONFIG 地址' };
    if (!isAllowedModelConfigUrl(target)) {
        return { success: false, error: '地址必须是 http:// 或 https:// 开头的 URL' };
    }
    if (typeof fetchImpl !== 'function') {
        return { success: false, error: '网络接口不可用' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    let response;
    try {
        response = await fetchImpl(target, {
            method: 'GET',
            headers: { accept: 'application/json', 'cache-control': 'no-cache' },
            signal: controller.signal
        });
    } catch (error) {
        const aborted = error?.name === 'AbortError';
        return { success: false, error: aborted ? '拉取模型配置超时' : `拉取模型配置失败：${error?.message || error}` };
    } finally {
        clearTimeout(timer);
    }

    if (!response?.ok) {
        return {
            success: false,
            status: response?.status,
            error: `服务器返回 HTTP ${response?.status ?? '未知'}`
        };
    }

    let text;
    try {
        text = await response.text();
    } catch (error) {
        return { success: false, error: `读取模型配置失败：${error?.message || error}` };
    }
    if (text.length > MAX_BYTES) {
        return { success: false, error: `模型配置过大（>${Math.round(MAX_BYTES / 1024)}KB），已拒绝` };
    }

    let config;
    try {
        config = JSON.parse(text);
    } catch (error) {
        return { success: false, error: `模型配置不是合法 JSON：${error.message}` };
    }

    const validation = validateModelConfig(config);
    if (!validation.ok) {
        return {
            success: false,
            error: `模型配置未通过 schema 校验（${validation.errors.length} 项）`,
            details: validation.errors.slice(0, 8)
        };
    }
    return { success: true, config, status: response.status };
}

module.exports = {
    DEFAULT_TIMEOUT_MS,
    MAX_BYTES,
    SCHEMA_PATH,
    fetchModelConfig,
    isAllowedModelConfigUrl,
    validateModelConfig
};
