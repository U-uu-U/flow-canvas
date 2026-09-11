import test from 'node:test';
import assert from 'node:assert/strict';
import { checkModelRequest, describeModelConfigStatus, formatModelRequestIssues, renderModelCapabilityPanel } from './model-config-ui.js';

// 极简 DOM 桩：model-config-ui 只用到 createElement / append / replaceChildren / textContent。
function installFakeDom() {
    const createElement = tagName => ({
        tagName,
        children: [],
        className: '',
        textContent: '',
        hidden: false,
        dataset: {},
        classList: { add() {}, toggle() {} },
        append(...nodes) { this.children.push(...nodes); },
        replaceChildren(...nodes) { this.children = nodes; },
        querySelector() { return null; }
    });
    globalThis.document = { createElement };
}

function collectText(node) {
    if (!node) return '';
    if (node.children?.length) return node.children.map(collectText).join(' ');
    return String(node.textContent || '');
}

test('checkModelRequest 给出可展示的中文拦截文案', () => {
    const blocked = checkModelRequest({
        provider: { model: 'sd2.5-route1' },
        kind: 'video',
        prompt: '一只猫',
        fields: { duration: 20 }
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.errors.length, 1);
    assert.match(blocked.message, /固定为 30/);

    const passed = checkModelRequest({
        provider: { model: 'sd2.5-route1' },
        kind: 'video',
        prompt: '一只猫',
        fields: { duration: 30, ratio: '16:9' },
        references: { image: { count: 3 } }
    });
    assert.equal(passed.ok, true);
    assert.equal(passed.message, '');
});

test('未收录模型只提示不拦截', () => {
    const result = checkModelRequest({
        provider: { model: 'my-private-model' },
        kind: 'video',
        prompt: '一只猫',
        fields: { duration: 999 }
    });
    assert.equal(result.ok, true);
    assert.equal(result.matched, false);
    assert.match(formatModelRequestIssues(result), /未收录在模型配置中/);
});

test('能力面板渲染「可以做 / 不能做 / 参数限制」与原表说明', () => {
    installFakeDom();
    const host = document.createElement('div');
    const rendered = renderModelCapabilityPanel(host, { model: 'sd2.5-route1' }, 'video');
    assert.equal(rendered, true);
    assert.equal(host.hidden, false);
    const text = collectText(host);
    assert.match(text, /模型能力/);
    assert.match(text, /可以做/);
    assert.match(text, /不能做/);
    assert.match(text, /参数限制/);
    assert.match(text, /参考图/);
    assert.match(text, /固定 30 秒/);
    assert.match(text, /原表说明/);
    assert.match(text, /通过率约90%/);
    // 面板必须显示配置来源，让用户知道这条限制从哪来
    assert.match(text, /内置默认配置|本地缓存|服务器/);
});

test('未收录模型的面板说明不做限制并提示配置来源', () => {
    installFakeDom();
    const host = document.createElement('div');
    renderModelCapabilityPanel(host, { model: 'my-private-model' }, 'video');
    const text = collectText(host);
    assert.match(text, /未收录/);
    assert.match(text, /不做参数限制/);
});

test('设置卡状态文案覆盖四种来源与错误态', () => {
    const base = {
        origin: 'builtin', originLabel: '内置默认配置', modelCount: 16, revision: 0, updatedAt: '',
        fetchedAt: null, url: '', urlConfigured: false, isDefaultUrl: false, refreshIntervalMs: 3600000, stale: true,
        refreshing: false, lastError: null, lastErrorAt: null, lastAttemptAt: null, nextRefreshAt: null
    };
    const builtin = describeModelConfigStatus(base);
    assert.equal(builtin.state, 'idle');
    assert.match(builtin.message, /未配置服务器地址/);
    assert.deepEqual(builtin.rows.map(row => row[0]),
        ['当前来源', '更新源', '配置版本', '配置更新时间', '上次拉取', '下次自动刷新']);
    assert.match(builtin.rows[0][1], /内置默认配置（16 个模型）/);
    assert.equal(builtin.rows[1][1], '已关闭（仅用本地配置）');
    assert.equal(builtin.rows[5][1], '—');

    const withDefaultSource = describeModelConfigStatus({
        ...base, url: 'https://artconfig.ravenhash.org/config', urlConfigured: true, isDefaultUrl: true
    });
    assert.equal(withDefaultSource.rows[1][1], '默认更新源 artconfig.ravenhash.org');
    assert.match(withDefaultSource.rows[5][1], /每 60 分钟/);

    const remote = describeModelConfigStatus({
        ...base, origin: 'remote', originLabel: '服务器', urlConfigured: true, isDefaultUrl: true, revision: 12,
        fetchedAt: Date.now(), stale: false, nextRefreshAt: Date.now() + 3600000, lastAttemptAt: Date.now()
    });
    assert.equal(remote.state, 'ok');
    assert.match(remote.message, /已从服务器获取最新配置/);
    assert.equal(remote.rows[2][1], 'r12');

    const cached = describeModelConfigStatus({ ...base, origin: 'cache', originLabel: '本地缓存', urlConfigured: true, stale: true });
    assert.equal(cached.state, 'warn');
    assert.match(cached.message, /本地缓存/);

    const failed = describeModelConfigStatus({ ...base, origin: 'cache', originLabel: '本地缓存', urlConfigured: true, lastError: '拉取模型配置超时', lastErrorAt: Date.now() });
    assert.equal(failed.state, 'error');
    assert.match(failed.message, /拉取模型配置超时/);
});
