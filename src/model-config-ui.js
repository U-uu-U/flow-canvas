// 模型 CONFIG 的 UI 层：
//   · 能力面板——把「能做什么 / 不能做什么 / 限制」画到图片、视频工作区；
//   · CONFIG 设置卡——服务器地址、立即刷新、来源与时间状态（挂在设置面板里，和诊断日志同一套路）；
//   · 提交前校验的文案格式化——供 agent-sidebar / canvas 在拦截时提示。
// 注意：CSS 由 main.js 统一 import（与 generation-recovery.css 同一约定）。
// 这里不 import CSS，否则 node --test 直接 import 本模块时会因 .css 扩展名失败。
import { DEFAULT_MODEL_CONFIG_URL, modelConfigStore } from './model-config.js';
import {
    describeModelCapabilities,
    resolveModelConfigEntry,
    validateModelRequest
} from './model-config-capabilities.js';

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

// ── 能力面板 ─────────────────────────────────────────────────
function buildCapabilityPanel(provider, kind) {
    const config = modelConfigStore.getConfig();
    const status = modelConfigStore.getStatus();
    const resolution = resolveModelConfigEntry(config, { ...provider, kind });
    const root = document.createElement('div');
    root.className = 'model-capability-panel';

    const head = document.createElement('div');
    head.className = 'model-capability-head';
    const title = document.createElement('strong');
    title.textContent = '模型能力';
    const source = document.createElement('span');
    source.className = 'model-capability-source';
    head.append(title, source);
    root.append(head);

    if (!resolution.matched) {
        source.textContent = '未收录';
        const empty = document.createElement('p');
        empty.className = 'model-capability-empty';
        empty.textContent = `当前模型（${provider?.model || '未选择'}）未收录在模型配置中，不做参数限制。${
            status.urlConfigured ? '' : '提示：可在设置面板配置 CONFIG 服务器地址以获取最新能力表。'}`;
        root.append(empty);
        return root;
    }

    const described = describeModelCapabilities(config, resolution.entry, {
        originLabel: status.originLabel
    });
    source.textContent = `${status.originLabel}${status.revision ? ` · r${status.revision}` : ''}`;
    // 同名模型可能分属多条线路（sd2.5 线路一/线路二、minimax-h3 兼容/按秒），
    // 明确写出当前生效的是哪一条，用户才知道这份限制来自哪里。
    const routeLine = [resolution.entry.channel, resolution.entry.route].filter(Boolean).join(' · ');
    if (routeLine) {
        const routeNode = document.createElement('p');
        routeNode.className = 'model-capability-route';
        routeNode.textContent = routeLine;
        root.append(routeNode);
    }
    if (resolution.ambiguous) {
        const note = document.createElement('p');
        note.className = 'model-capability-note';
        note.textContent = `同名模型命中 ${resolution.candidates.length} 条线路（${resolution.candidates
            .map(entry => entry.route || entry.channel).join(' / ')}），参数限制按「所有线路共同要求」执行。`;
        root.append(note);
    }

    const groups = [
        { key: 'can', title: '可以做', items: described.can, render: item => [item.label, item.detail] },
        { key: 'cannot', title: '不能做', items: described.cannot, render: item => [item.label, item.reason] }
    ];
    for (const group of groups) {
        if (!group.items.length) continue;
        const section = document.createElement('div');
        section.className = `model-capability-group model-capability-group-${group.key}`;
        const label = document.createElement('span');
        label.className = 'model-capability-group-title';
        label.textContent = group.title;
        const list = document.createElement('ul');
        for (const item of group.items) {
            const [name, detail] = group.render(item);
            const li = document.createElement('li');
            const strong = document.createElement('b');
            strong.textContent = name;
            li.append(strong);
            if (detail) {
                const small = document.createElement('small');
                small.textContent = detail;
                li.append(small);
            }
            list.append(li);
        }
        section.append(label, list);
        root.append(section);
    }

    const limitTexts = [...described.limits, ...described.notes];
    if (limitTexts.length) {
        const section = document.createElement('div');
        section.className = 'model-capability-group model-capability-group-limits';
        const label = document.createElement('span');
        label.className = 'model-capability-group-title';
        label.textContent = '参数限制';
        const list = document.createElement('ul');
        for (const text of limitTexts) {
            const li = document.createElement('li');
            li.textContent = text;
            list.append(li);
        }
        section.append(label, list);
        root.append(section);
    }

    if (described.notesText) {
        const notes = document.createElement('p');
        notes.className = 'model-capability-note';
        notes.textContent = `原表说明：${described.notesText}`;
        root.append(notes);
    }
    return root;
}

/**
 * 把能力面板渲染到 host（不存在则隐藏 host）。返回是否渲染成功。
 */
export function renderModelCapabilityPanel(host, provider = {}, kind = 'image') {
    if (!host) return false;
    const panel = buildCapabilityPanel(provider, kind);
    host.replaceChildren(panel);
    host.hidden = false;
    return true;
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
