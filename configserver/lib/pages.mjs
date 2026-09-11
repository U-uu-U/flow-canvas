// 服务端渲染的页面：登录页、管理面板、公开落地页。
// 不引入任何前端框架/构建步骤——纯 HTML + 少量原生 JS，方便直接拷到服务器上跑。
import { SESSION_COOKIE } from './auth.mjs';

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0f1116; color: #e6e8ee; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
a { color: #7fb2ff; }
header { padding: 16px 22px; border-bottom: 1px solid #23262f; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
header h1 { font-size: 16px; margin: 0; font-weight: 600; }
header .spacer { flex: 1 1 auto; }
main { padding: 18px 22px 60px; max-width: 1180px; }
section { margin-bottom: 26px; }
h2 { font-size: 14px; margin: 0 0 10px; color: #aab2c5; font-weight: 600; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #1d2430; color: #9fb0cc; font-size: 12px; border: 1px solid #2c3444; }
.badge.ok { background: #14291b; color: #8fd3a6; border-color: #24512f; }
.badge.warn { background: #2b2413; color: #e6c07b; border-color: #4d4020; }
.badge.err { background: #2c1717; color: #e7a1a1; border-color: #54282a; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 7px 9px; border-bottom: 1px solid #23262f; white-space: nowrap; }
th { color: #8c95a8; font-weight: 500; }
tr.current td { background: #16202c; }
tr.broken td { background: #2a1a1a; }
textarea { width: 100%; min-height: 420px; background: #0b0d12; color: #dfe6f2; border: 1px solid #2b3140; border-radius: 8px; padding: 12px; font: 12.5px/1.5 ui-monospace, Consolas, "Courier New", monospace; resize: vertical; }
input[type=password], input[type=text], input[type=url] { background: #0b0d12; color: inherit; border: 1px solid #2b3140; border-radius: 8px; padding: 8px 10px; min-width: 260px; font: inherit; }
button { background: #1d2534; color: #dce3f2; border: 1px solid #313b4d; border-radius: 8px; padding: 7px 12px; cursor: pointer; font: inherit; }
button:hover { background: #24304a; }
button.primary { background: #2b5fd9; border-color: #3a6ce0; color: #fff; }
button.primary:hover { background: #3568e6; }
button.danger { border-color: #54282a; color: #e7a1a1; background: #241416; }
button.link { background: none; border: none; color: #7fb2ff; padding: 0; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.row + .row { margin-top: 10px; }
.muted { color: #8c95a8; }
.mono { font-family: ui-monospace, Consolas, monospace; }
.flash { padding: 10px 12px; border-radius: 8px; margin-bottom: 14px; border: 1px solid #2c3444; background: #161b24; }
.flash.ok { background: #14291b; border-color: #24512f; color: #b6e6c6; }
.flash.err { background: #2c1717; border-color: #54282a; color: #f0c0c0; }
pre.errors { background: #1a1113; border: 1px solid #54282a; border-radius: 8px; padding: 10px; overflow: auto; max-height: 240px; color: #f0c0c0; font-size: 12.5px; }
.login { max-width: 380px; margin: 12vh auto; }
.login form { display: grid; gap: 10px; }
.login input { width: 100%; }
.audit { font-size: 12.5px; }
code { background: #161b24; padding: 1px 5px; border-radius: 5px; }
`;

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function layout(title, body) {
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body>${body}</body></html>
`;
}

export function loginPage({ error = '', publicConfigPath = '/config' } = {}) {
    return layout('模型配置服务 · 登录', `
<div class="login">
  <h1 style="font-size:16px">模型配置服务</h1>
  <p class="muted">客户端从这里获取模型能力 CONFIG：<a href="${escapeHtml(publicConfigPath)}"><code>${escapeHtml(publicConfigPath)}</code></a></p>
  ${error ? `<div class="flash err">${escapeHtml(error)}</div>` : ''}
  <form method="post" action="login">
    <input type="password" name="password" placeholder="管理密码" autocomplete="current-password" autofocus required>
    <button class="primary" type="submit">登录</button>
  </form>
</div>`);
}

function formatBytes(size) {
    if (!Number.isFinite(size) || size <= 0) return '—';
    return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
}

function versionRows(versions, { csrf, editing }) {
    if (!versions.length) return '<tr><td colspan="6" class="muted">还没有任何版本</td></tr>';
    return versions.map(version => {
        const cells = [
            `<td class="mono">${escapeHtml(version.name)}</td>`,
            `<td>${version.broken ? '<span class="badge err">损坏</span>' : `r${escapeHtml(version.revision)}`}</td>`,
            `<td>${version.broken ? '—' : escapeHtml(version.modelCount)}</td>`,
            `<td>${formatBytes(version.size)}</td>`,
            `<td class="mono muted">${escapeHtml(version.updatedAt || '')}</td>`,
            `<td>${version.current ? '<span class="badge ok">现行</span>' : (version.name === editing ? '<span class="badge">编辑中</span>' : '')}</td>`
        ];
        const actions = [];
        actions.push(`<a class="link" href="admin?version=${encodeURIComponent(version.name)}">载入编辑器</a>`);
        if (!version.current) {
            actions.push(`<form method="post" action="apply" style="display:inline">
                <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
                <input type="hidden" name="name" value="${escapeHtml(version.name)}">
                <button class="link" type="submit">应用为现行</button></form>`);
            actions.push(`<form method="post" action="delete" style="display:inline" onsubmit="return confirm('确认删除 ${escapeHtml(version.name)}？该操作不可撤销。')">
                <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
                <input type="hidden" name="name" value="${escapeHtml(version.name)}">
                <button class="link danger" type="submit" style="color:#e7a1a1">删除</button></form>`);
        }
        actions.push(`<a class="link" href="download?name=${encodeURIComponent(version.name)}">下载</a>`);
        cells.push(`<td class="row" style="gap:8px">${actions.join('')}</td>`);
        return `<tr class="${version.current ? 'current' : ''}${version.broken ? ' broken' : ''}">${cells.join('')}</tr>`;
    }).join('');
}

export function adminPage({
    versions = [], current = null, editorText = '', editing = '', history = [],
    flash = '', error = '', csrf = '', validatorMode = 'schema', validatorNote = '',
    publicConfigPath = '/config', publicOrigin = ''
} = {}) {
    const currentLabel = current
        ? `r${escapeHtml(current.config?.revision ?? 0)} · ${escapeHtml(Array.isArray(current.config?.models) ? current.config.models.length : 0)} 个模型 · <span class="mono">${escapeHtml(current.name)}</span>`
        : '<span class="badge warn">尚无现行版本</span>';
    const modeBadge = validatorMode === 'schema'
        ? '<span class="badge ok">schema 校验（ajv）</span>'
        : `<span class="badge warn">结构校验（降级）</span>`;
    const auditRows = history.length
        ? history.map(entry => `<tr>
            <td class="mono muted">${escapeHtml(entry.at)}</td>
            <td>${escapeHtml(entry.action)}</td>
            <td class="mono">${escapeHtml(entry.name || '')}</td>
            <td>${escapeHtml(entry.actor || '')}</td>
            <td class="muted">${escapeHtml(entry.note || entry.reason || (entry.previous ? `来自 ${entry.previous}` : ''))}</td>
          </tr>`).join('')
        : '<tr><td colspan="5" class="muted">暂无记录</td></tr>';

    const configUrl = `${publicOrigin || ''}${publicConfigPath}`;
    return layout('模型配置服务 · 管理面板', `
<header>
  <h1>模型能力 CONFIG 管理</h1>
  ${modeBadge}
  <span class="badge">现行：${currentLabel}</span>
  <span class="spacer"></span>
  <span class="muted">客户端地址 <a href="${escapeHtml(publicConfigPath)}"><code>${escapeHtml(configUrl)}</code></a></span>
  <form method="post" action="logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">退出登录</button></form>
</header>
<main>
  ${flash ? `<div class="flash ok">${escapeHtml(flash)}</div>` : ''}
  ${error ? `<div class="flash err">${escapeHtml(error)}</div>` : ''}
  ${validatorNote ? `<div class="flash">${escapeHtml(validatorNote)}</div>` : ''}

  <section>
    <h2>编辑配置${editing ? `（基于 <span class="mono">${escapeHtml(editing)}</span>）` : '（基于现行版本）'}</h2>
    <form method="post" action="save" id="configForm">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="basedOn" value="${escapeHtml(editing)}">
      <textarea name="content" id="configText" spellcheck="false" aria-label="配置 JSON">${escapeHtml(editorText)}</textarea>
      <div class="row" style="margin-top:10px">
        <button class="primary" type="submit">保存并应用</button>
        <label class="muted"><input type="checkbox" name="draft" value="1"> 仅保存为版本（不切换现行）</label>
        <input type="text" name="note" placeholder="变更说明（可选）" style="min-width:240px">
      </div>
      <div class="row">
        <button type="button" id="formatBtn">格式化</button>
        <button type="button" id="validateBtn">校验</button>
        <button type="button" id="resetBtn">放弃修改，重新载入现行</button>
        <input type="text" id="jumpRevision" placeholder="跳到指定版本名" style="min-width:260px">
        <button type="button" id="jumpBtn">载入</button>
        <span class="muted" id="editorState"></span>
      </div>
      <pre class="errors" id="editorErrors" hidden></pre>
    </form>
  </section>

  <section>
    <h2>版本（共 ${versions.length} 个 · 每次保存都会生成带时间戳的新文件，老版本自动留档）</h2>
    <table>
      <thead><tr><th>版本文件</th><th>revision</th><th>模型数</th><th>大小</th><th>配置 updatedAt</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${versionRows(versions, { csrf, editing })}</tbody>
    </table>
  </section>

  <section>
    <h2>操作记录（最近 ${history.length} 条）</h2>
    <table class="audit">
      <thead><tr><th>时间</th><th>动作</th><th>版本</th><th>操作者</th><th>备注</th></tr></thead>
      <tbody>${auditRows}</tbody>
    </table>
  </section>
</main>
<script>
(() => {
  const form = document.getElementById('configForm');
  const text = document.getElementById('configText');
  const state = document.getElementById('editorState');
  const errors = document.getElementById('editorErrors');
  const csrf = ${JSON.stringify(csrf)};
  const setState = (message, bad) => { state.textContent = message || ''; state.style.color = bad ? '#e7a1a1' : '#8fd3a6'; };
  const showErrors = list => {
    if (!list || !list.length) { errors.hidden = true; errors.textContent = ''; return; }
    errors.hidden = false;
    errors.textContent = list.map((item, index) => (index + 1) + '. ' + item).join('\\n');
  };
  document.getElementById('formatBtn').addEventListener('click', () => {
    try { text.value = JSON.stringify(JSON.parse(text.value), null, 2); setState('已格式化'); showErrors(null); }
    catch (error) { setState('JSON 解析失败', true); showErrors([error.message]); }
  });
  document.getElementById('validateBtn').addEventListener('click', async () => {
    setState('校验中…');
    try {
      const response = await fetch('validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: text.value
      });
      const result = await response.json();
      if (result.ok) { setState('校验通过 · ' + result.modelCount + ' 个模型 · ' + result.mode + ' 模式'); showErrors(null); }
      else { setState('校验未通过', true); showErrors(result.errors); }
    } catch (error) { setState('校验请求失败：' + error.message, true); }
  });
  document.getElementById('resetBtn').addEventListener('click', () => { location.href = 'admin'; });
  document.getElementById('jumpBtn').addEventListener('click', () => {
    const name = document.getElementById('jumpRevision').value.trim();
    if (name) location.href = 'admin?version=' + encodeURIComponent(name);
  });
  form.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); form.requestSubmit(); }
  });
})();
</script>`);
}

export function landingPage({ current = null, publicConfigPath = '/config', adminPath = '/admin' } = {}) {
    const summary = current
        ? `<li>revision：<code>${escapeHtml(current.config?.revision ?? 0)}</code></li>
           <li>模型数：<code>${escapeHtml(Array.isArray(current.config?.models) ? current.config.models.length : 0)}</code></li>
           <li>配置 updatedAt：<code>${escapeHtml(current.config?.updatedAt || '')}</code></li>
           <li>版本文件：<code>${escapeHtml(current.name)}</code></li>`
        : '<li>尚无现行版本，请先登录管理面板发布一个。</li>';
    return layout('模型配置服务', `
<header><h1>Flow Canvas 模型能力 CONFIG 服务</h1></header>
<main>
  <section>
    <h2>客户端拉取地址</h2>
    <p><a href="${escapeHtml(publicConfigPath)}"><code>${escapeHtml(publicConfigPath)}</code></a>（公开只读，客户端每 1 小时拉取一次，也可手动刷新）</p>
  </section>
  <section>
    <h2>当前版本</h2>
    <ul>${summary}</ul>
  </section>
  <section>
    <h2>管理</h2>
    <p><a href="${escapeHtml(adminPath)}">进入管理面板</a>（需要密码）</p>
  </section>
</main>`);
}

export { SESSION_COOKIE };
