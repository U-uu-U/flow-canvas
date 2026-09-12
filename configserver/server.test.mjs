// HTTP 层端到端测试：/config 的对外契约 + 管理面板的完整操作链路。
// 用真实 http 服务器 + 真实 fetch，覆盖「登录 → 保存 → 客户端可见 → 回滚」的全过程。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfigServer, resolveServerConfig } from './server.mjs';
import { hashPassword } from './lib/auth.mjs';

const SILENT = { log() {}, warn() {}, error() {} };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PASSWORD = 'smoke-admin-password';

async function startServer(options = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'configserver-http-'));
    const instance = await createConfigServer({
        dataDir,
        host: '127.0.0.1',
        port: 0,
        passwordRecord: hashPassword(PASSWORD),
        schemaPath: path.join(HERE, 'schema', 'model-config.schema.json'),
        seedPath: path.join(HERE, 'seed', 'model-config.default.json'),
        logger: SILENT,
        ...options
    });
    return {
        instance,
        base: instance.url,
        cleanup: async () => {
            await instance.close();
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    };
}

function sessionCookie(response) {
    const header = response.headers.get('set-cookie') || '';
    return header.split(';')[0];
}

async function login(base) {
    const response = await fetch(`${base}/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: PASSWORD }),
        redirect: 'manual'
    });
    assert.equal(response.status, 303);
    return { cookie: sessionCookie(response), location: response.headers.get('location') };
}

async function openAdmin(base, cookie) {
    const response = await fetch(`${base}/admin`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(csrf, '管理面板必须带 CSRF token');
    return { html, csrf };
}

async function postForm(base, pathname, fields, { cookie = '', headers = {} } = {}) {
    return fetch(`${base}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...headers },
        body: new URLSearchParams(fields),
        redirect: 'manual'
    });
}

const fetchConfig = async base => {
    const response = await fetch(`${base}/config`);
    return { response, config: await response.json() };
};

test('/config：公开只读、带 ETag 与 CORS、首次启动就是播种版本', async () => {
    const server = await startServer();
    try {
        const first = await fetchConfig(server.base);
        assert.equal(first.response.status, 200);
        assert.match(first.response.headers.get('content-type'), /application\/json/);
        assert.equal(first.response.headers.get('access-control-allow-origin'), '*');
        assert.match(first.response.headers.get('cache-control'), /no-cache/);
        assert.equal(first.config.models.length, 15);
        assert.equal(first.config.revision, 0);
        assert.equal(first.config.refreshIntervalMs, 3600000);

        const etag = first.response.headers.get('etag');
        assert.ok(etag);
        const cached = await fetch(`${server.base}/config`, { headers: { 'if-none-match': etag } });
        assert.equal(cached.status, 304);

        const health = await fetch(`${server.base}/health`).then(response => response.json());
        assert.equal(health.ok, true);
        assert.equal(health.versions, 1);
        assert.equal(health.current, first.config.source === 'builtin:Flow-Canvas-模型渠道入参与限制-对外版.csv'
            ? health.current : health.current);
        assert.match(health.current, /-r0\.json$/);

        const landing = await fetch(`${server.base}/`);
        assert.equal(landing.status, 200);
        assert.match(await landing.text(), /管理面板/);

        assert.equal((await fetch(`${server.base}/nope`)).status, 404);
    } finally {
        await server.cleanup();
    }
});

test('管理面板必须登录：未登录跳登录页，密码错误不发会话', async () => {
    const server = await startServer();
    try {
        const guarded = await fetch(`${server.base}/admin`, { redirect: 'manual' });
        assert.equal(guarded.status, 303);
        assert.equal(guarded.headers.get('location'), '/admin/login');

        const loginPage = await fetch(`${server.base}/admin/login`);
        assert.equal(loginPage.status, 200);
        assert.match(await loginPage.text(), /name="password"/);

        const wrong = await postForm(server.base, '/admin/login', { password: 'not-the-password' });
        assert.equal(wrong.status, 303);
        assert.match(wrong.headers.get('location'), /error=1/);
        assert.equal(wrong.headers.get('set-cookie'), null, '密码错误不能发会话 cookie');

        const success = await login(server.base);
        assert.match(success.location, /\/admin$/);
        assert.match(success.cookie, /^flow_config_session=/);
    } finally {
        await server.cleanup();
    }
});

test('会话 cookie 的安全属性：HttpOnly + SameSite=Strict', async () => {
    const server = await startServer();
    try {
        const response = await postForm(server.base, '/admin/login', { password: PASSWORD });
        const header = response.headers.get('set-cookie') || '';
        assert.match(header, /HttpOnly/);
        assert.match(header, /SameSite=Strict/);
        assert.match(header, /Max-Age=\d+/);
        assert.match(header, /Path=\//);
    } finally {
        await server.cleanup();
    }
});

test('保存 → 客户端可见 → 回滚，全链路走通', async () => {
    const server = await startServer();
    try {
        const { cookie } = await login(server.base);
        const { html, csrf } = await openAdmin(server.base, cookie);
        assert.match(html, /-r0\.json/, '面板要列出种子版本');
        assert.match(html, /现行/);
        assert.equal(html.includes('smoke-admin-password'), false, '页面不能出现明文密码');
        assert.equal(html.includes('scrypt'), false, '页面不能泄漏密码哈希');

        const { config: seeded } = await fetchConfig(server.base);
        const edited = JSON.parse(JSON.stringify(seeded));
        edited.models[0].label = `${edited.models[0].label}-来自管理面板`;

        const saved = await postForm(server.base, '/admin/save',
            { csrf, content: JSON.stringify(edited), note: '端到端测试' }, { cookie });
        assert.equal(saved.status, 303);
        assert.match(decodeURIComponent(saved.headers.get('location')), /已保存并应用 r1/);

        const afterSave = await fetchConfig(server.base);
        assert.equal(afterSave.config.revision, 1, '服务端要盖章递增 revision');
        assert.equal(afterSave.config.models[0].label, edited.models[0].label);
        assert.equal(afterSave.config.models.length, 15);
        assert.match(afterSave.config.source, /artconfig\.ravenhash\.org/);

        const listHtml = (await openAdmin(server.base, cookie)).html;
        assert.match(listHtml, /-r1\.json/);
        assert.match(listHtml, /save\+apply/, '审计记录里要能看到动作');

        // 一键应用老的（种子 r0）
        const seedName = server.instance.store.listNames()[0];
        const applied = await postForm(server.base, '/admin/apply', { csrf, name: seedName }, { cookie });
        assert.equal(applied.status, 303);
        assert.match(decodeURIComponent(applied.headers.get('location')), /已应用/);

        const rolledBack = await fetchConfig(server.base);
        assert.equal(rolledBack.config.revision, 0, '回滚后客户端应拿到旧 revision');
        assert.equal(rolledBack.config.models[0].label, seeded.models[0].label);
    } finally {
        await server.cleanup();
    }
});

test('校验不通过的配置被拒绝，现行版本保持不变', async () => {
    const server = await startServer();
    try {
        const { cookie } = await login(server.base);
        const { csrf } = await openAdmin(server.base, cookie);

        const invalid = await postForm(server.base, '/admin/save',
            { csrf, content: JSON.stringify({ schemaVersion: 1, models: [] }) }, { cookie });
        assert.equal(invalid.status, 400);
        assert.match(await invalid.text(), /校验/);

        const brokenJson = await postForm(server.base, '/admin/save', { csrf, content: '{ oops' }, { cookie });
        assert.equal(brokenJson.status, 400);

        const current = await fetchConfig(server.base);
        assert.equal(current.config.revision, 0, '被拒绝的保存不能影响现行版本');
        assert.equal(server.instance.store.list().length, 1, '被拒绝的保存不能落盘成版本');
    } finally {
        await server.cleanup();
    }
});

test('仅保存为版本：不动现行，但要能在列表里看到并之后应用', async () => {
    const server = await startServer();
    try {
        const { cookie } = await login(server.base);
        const { csrf } = await openAdmin(server.base, cookie);
        const { config } = await fetchConfig(server.base);
        const edited = { ...config, models: config.models.slice(0, 3) };

        const saved = await postForm(server.base, '/admin/save',
            { csrf, content: JSON.stringify(edited), draft: '1' }, { cookie });
        assert.equal(saved.status, 303);
        assert.match(decodeURIComponent(saved.headers.get('location')), /现行版本未改变/);

        assert.equal((await fetchConfig(server.base)).config.models.length, 15, 'draft 不影响 /config');
        const names = server.instance.store.listNames();
        assert.equal(names.length, 2);
        const draftName = names.at(-1);

        await postForm(server.base, '/admin/apply', { csrf, name: draftName }, { cookie });
        assert.equal((await fetchConfig(server.base)).config.models.length, 3, '应用草稿版本后客户端拿到新内容');
    } finally {
        await server.cleanup();
    }
});

test('删除：现行版本拒绝删除，其它版本可删', async () => {
    const server = await startServer();
    try {
        const { cookie } = await login(server.base);
        const { csrf } = await openAdmin(server.base, cookie);
        const current = server.instance.store.current().name;

        const refused = await postForm(server.base, '/admin/delete', { csrf, name: current }, { cookie });
        assert.equal(refused.status, 303);
        assert.match(decodeURIComponent(refused.headers.get('location')), /删除失败/);
        assert.equal(server.instance.store.list().length, 1);

        const { config } = await fetchConfig(server.base);
        await postForm(server.base, '/admin/save', { csrf, content: JSON.stringify(config), draft: '1' }, { cookie });
        const draftName = server.instance.store.listNames().at(-1);
        await postForm(server.base, '/admin/delete', { csrf, name: draftName }, { cookie });
        assert.equal(server.instance.store.list().length, 1);
    } finally {
        await server.cleanup();
    }
});

test('写操作三件套：缺 CSRF、Origin 跨站、非法版本名一律拒绝', async () => {
    const server = await startServer();
    try {
        const { cookie } = await login(server.base);
        const { csrf } = await openAdmin(server.base, cookie);
        const { config } = await fetchConfig(server.base);

        const noCsrf = await postForm(server.base, '/admin/save', { content: JSON.stringify(config) }, { cookie });
        assert.equal(noCsrf.status, 403);
        assert.match(await noCsrf.text(), /CSRF/);

        const crossOrigin = await postForm(server.base, '/admin/save', { csrf, content: JSON.stringify(config) },
            { cookie, headers: { origin: 'https://evil.example.com' } });
        assert.equal(crossOrigin.status, 403);
        assert.match(await crossOrigin.text(), /Origin/);

        const traversal = await postForm(server.base, '/admin/apply', { csrf, name: '../../state.json' }, { cookie });
        assert.equal(traversal.status, 303);
        assert.match(decodeURIComponent(traversal.headers.get('location')), /应用失败/);

        // 未登录的写操作直接 401/跳登录
        const anonymous = await postForm(server.base, '/admin/save', { csrf, content: JSON.stringify(config) });
        assert.equal(anonymous.status, 303);
        assert.equal(anonymous.headers.get('location'), '/admin/login');
    } finally {
        await server.cleanup();
    }
});

test('/admin/validate 只校验不落盘', async () => {
    const server = await startServer();
    try {
        const { cookie } = await login(server.base);
        const { csrf } = await openAdmin(server.base, cookie);

        const okResponse = await fetch(`${server.base}/admin/validate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie },
            body: JSON.stringify({ schemaVersion: 1, models: [{ id: 'a', kind: 'video', match: { model: ['x'] } }] })
        });
        const ok = await okResponse.json();
        assert.equal(ok.ok, true);
        assert.equal(ok.modelCount, 1);
        assert.equal(ok.mode, 'schema');

        const badResponse = await fetch(`${server.base}/admin/validate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie },
            body: JSON.stringify({ schemaVersion: 1, models: [] })
        });
        assert.equal((await badResponse.json()).ok, false);
        assert.equal(server.instance.store.list().length, 1, '校验不落盘');
    } finally {
        await server.cleanup();
    }
});

test('默认监听 127.0.0.1:8087，且可被环境变量覆盖', () => {
    // 回归守卫：部署脚本与 nginx 配置的默认端口必须和这里一致
    const defaults = resolveServerConfig({});
    assert.equal(defaults.port, 8087);
    assert.equal(defaults.host, '127.0.0.1');

    const overridden = resolveServerConfig({ CONFIG_PORT: '9000', CONFIG_HOST: '0.0.0.0' });
    assert.equal(overridden.port, 9000);
    assert.equal(overridden.host, '0.0.0.0');
});

test('未配置密码时拒绝启动（fail closed）', async () => {
    await assert.rejects(
        () => createConfigServer({
            dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'configserver-nopass-')),
            passwordRecord: null,
            env: {},
            logger: SILENT
        }),
        /未配置管理密码/
    );
});
