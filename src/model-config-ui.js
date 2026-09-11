// 模型 CONFIG 的 UI 层：
//   · CONFIG 设置卡——服务器地址、立即刷新、来源与时间状态（挂在设置面板里，和诊断日志同一套路）；
//   · 提交前校验的文案格式化——供画布节点生成时提示。
// 注意：CSS 由 main.js 统一 import（与 generation-recovery.css 同一约定）。
// 这里不 import CSS，否则 node --test 直接 import 本模块时会因 .css 扩展名失败。
import { DEFAULT_MODEL_CONFIG_URL, modelConfigStore } from './model-config.js';
import { validateModelRequest } from './model-config-capabilities.js';

function formatTime(value) {
    const time = Number(value);
    if (!Number.isFinite(time) || time <= 0) return '—';
    try {
        return new Date(time).toLocaleString('zh-CN', { hour12: false });
    } catch (_) {
        return new Date(time).toISOString();
    }
}

function formatRelative(target) {
    const delta = Number(target) - Date.now();
    if (!Number.isFinite(delta)) return '—';
    if (delta <= 0) return '即将刷新';
    const minutes = Math.round(delta / 60000);
    if (minutes < 60) return `${minutes} 分钟后`;
    return `${Math.round(minutes / 60)} 小时后`;
}

// ── 提交前校验 ───────────────────────────────────────────────
/**
 * 校验一次生成请求。返回值里的 `message` 已经是可直接展示的中文文案。
 * 未收录的模型 / 未知边界的警告也会带上，供 UI 以提示方式展示。
 */
export function checkModelRequest({ provider = {}, kind = 'image', fields = {}, features = {}, references = {}, prompt = '', promptResolved = true } = {}) {
    const result = validateModelRequest({
        config: modelConfigStore.getConfig(),
        provider: { ...provider, kind },
        fields,
        features,
        references,
        prompt,
        promptResolved
    });
    return {
        ...result,
        message: formatModelRequestIssues(result)
    };
}

export function formatModelRequestIssues(result) {
    const parts = [];
    for (const item of result?.errors || []) parts.push(item.message);
    for (const item of result?.warnings || []) parts.push(item.message);
    return parts.join('；');
}

export function assertModelRequest(options) {
    const result = checkModelRequest(options);
    if (!result.ok) {
        throw new Error(`当前模型参数不被支持：${result.errors.map(item => item.message).join('；')}`);
    }
    return result;
}

// ── 设置卡 ───────────────────────────────────────────────────
// 纯函数：把存储状态翻译成「状态行 + 摘要表」，便于单测（DOM 部分只剩赋值）。
export function describeModelConfigStatus(status) {
    const sourceLabel = !status.urlConfigured
        ? '已关闭（仅用本地配置）'
        : (status.isDefaultUrl ? '默认更新源 artconfig.ravenhash.org' : '自定义地址');
    const rows = [
        ['当前来源', `${status.originLabel}（${status.modelCount} 个模型）`],
        ['更新源', sourceLabel],
        ['配置版本', Number.isFinite(Number(status.revision)) ? `r${status.revision}` : '—'],
        ['配置更新时间', status.updatedAt ? new Date(status.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '—'],
        ['上次拉取', status.fetchedAt ? formatTime(status.fetchedAt) : '尚未拉取'],
        ['下次自动刷新', status.urlConfigured
            ? `${formatRelative(status.nextRefreshAt)}（每 ${Math.round(status.refreshIntervalMs / 60000)} 分钟）`
            : '—']
    ];
    let state = 'idle';
    let message = '正在使用内置默认配置。';
    if (status.lastError) {
        state = 'error';
        message = `${status.lastError}（${formatTime(status.lastErrorAt)}）`;
    } else if (!status.urlConfigured) {
        message = '未配置服务器地址，当前使用内置默认配置（对外版 CSV）。';
    } else if (status.origin === 'remote') {
        state = 'ok';
        message = '已从服务器获取最新配置。';
    } else if (status.origin === 'cache') {
        state = 'warn';
        message = status.stale ? '服务器暂不可用，正在使用本地缓存。' : '正在使用本地缓存。';
    }
    return { state, message, rows };
}

function renderSettingsStatus(root) {
    const status = modelConfigStore.getStatus();
    const { state, message, rows } = describeModelConfigStatus(status);
    const summary = root.querySelector('[data-config-summary]');
    if (summary) {
        summary.replaceChildren(...rows.map(([term, value]) => {
            const wrapper = document.createElement('div');
            const dt = document.createElement('dt');
            dt.textContent = term;
            const dd = document.createElement('dd');
            dd.textContent = value;
            wrapper.append(dt, dd);
            return wrapper;
        }));
    }
    const statusNode = root.querySelector('[data-config-state]');
    if (statusNode) {
        statusNode.textContent = message;
        statusNode.dataset.state = state;
    }
    const input = root.querySelector('[data-config-url]');
    if (input && document.activeElement !== input) input.value = status.url;
}

function mountModelConfigSettings() {
    const host = document.querySelector('#agentSettings');
    if (!host || document.getElementById('modelConfigSettings')) return;
    const root = document.createElement('details');
    root.className = 'model-config-settings';
    root.id = 'modelConfigSettings';
    root.innerHTML = `<summary>模型能力配置 CONFIG</summary>
        <div class="model-config-url-row">
            <input type="url" inputmode="url" spellcheck="false" data-config-url
                placeholder="${DEFAULT_MODEL_CONFIG_URL}" aria-label="模型配置服务器地址">
            <button type="button" data-config="save">保存并刷新</button>
        </div>
        <div class="model-config-actions">
            <button type="button" data-config="refresh">立即刷新</button>
            <button type="button" data-config="reset">恢复内置默认配置</button>
        </div>
        <div class="model-config-state" data-config-state role="status" aria-live="polite"></div>
        <dl class="model-config-summary" data-config-summary></dl>
        <p class="model-config-hint">留空并保存可关闭远端更新；默认更新源为 ${DEFAULT_MODEL_CONFIG_URL}，每 1 小时自动拉取一次。</p>`;
    host.append(root);

    const open = () => renderSettingsStatus(root);
    root.addEventListener('toggle', () => { if (root.open) open(); });
    root.addEventListener('click', async event => {
        const button = event.target.closest('[data-config]');
        if (!button || button.disabled) return;
        const action = button.dataset.config;
        button.disabled = true;
        const state = root.querySelector('[data-config-state]');
        try {
            if (action === 'reset') {
                modelConfigStore.reset();
                state.textContent = '已恢复内置默认配置。';
                state.dataset.state = 'ok';
            } else {
                if (action === 'save') {
                    const input = root.querySelector('[data-config-url]');
                    const saved = modelConfigStore.setUrl(input?.value || '');
                    if (!saved.ok) {
                        state.textContent = saved.error;
                        state.dataset.state = 'error';
                        return;
                    }
                }
                state.textContent = '正在拉取模型配置...';
                state.dataset.state = 'idle';
                const result = await modelConfigStore.refresh({ force: true });
                state.textContent = result.ok
                    ? `已更新到 r${modelConfigStore.getStatus().revision}（${modelConfigStore.getStatus().modelCount} 个模型）`
                    : `拉取失败：${result.error}`;
                state.dataset.state = result.ok ? 'ok' : 'error';
            }
        } finally {
            button.disabled = false;
            open();
        }
    });

    modelConfigStore.subscribe(() => { if (root.open) open(); });
    open();
}

/**
 * 启动 CONFIG 系统并挂载设置卡。重复调用是安全的。
 * 由 main.js 的 bootstrap 调用一次。
 */
export function initModelConfigUi() {
    modelConfigStore.start();
    mountModelConfigSettings();
    return modelConfigStore;
}
