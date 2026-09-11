// 模型 CONFIG 的端到端烟测（不依赖 Playwright）。
//
// 覆盖的是单元测试碰不到的一层，而且把**真实的 configserver 和真实的客户端**接在一起跑：
//
//   1. 起真实 configserver（临时数据目录，播种内置默认配置 → r0）；
//   2. 起真实 Electron 主进程 + 真实 dist 渲染层，窗口隐藏；
//   3. 渲染层把自己指向这个本地服务（通过 localStorage，顺便验证持久化地址在启动时生效）；
//   4. 断言能力面板真的画出了服务端配置里的内容（改一条 note 作为指纹）；
//   5. 用管理接口回滚到旧版本，再在界面上点「立即刷新」，断言客户端跟着回到旧版本；
//   6. 直接走 IPC 验证远端拉取的三种结果：合法、404、非白名单地址。
//
// 运行：npm run test:model-config:smoke
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');
const { ApiConfigStore } = require('../electron-main/api-config-store');

const HERE = path.dirname(__filename);
const ADMIN_PASSWORD = 'smoke-admin-password';
const FINGERPRINT = '流水线烟测指纹';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-model-config-smoke-'));
fs.mkdirSync(path.join(profile, 'data', 'asset-library'), { recursive: true });
fs.writeFileSync(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, items: [], folderGroups: [], mcp: { enabled: false } }));

// 预置一个视频 provider，用来验证 CONFIG → 既有 video profile → UI 的完整链路：
// sd2.5-route1 在默认 CONFIG 里是「固定 30 秒、最多 9 张参考图」。
const seeded = new ApiConfigStore(profile).save({
    version: 1,
    revision: 2,
    providers: [{
        id: 'smoke-video',
        name: 'Smoke Video',
        type: 'openai',
        capability: 'video',
        endpoint: 'https://smoke.test/v1',
        model: 'sd2.5-route1',
        apiKey: 'smoke-key'
    }],
    globalConfig: { videoProviderId: 'smoke-video' }
});
if (seeded.success !== true) throw new Error(`无法写入烟测 profile：${seeded.error}`);

app.setPath('userData', profile);
Object.defineProperty(app, 'isPackaged', { value: true });

let settled = false;
function finish(code, message) {
    if (settled) return;
    settled = true;
    console.log(message);
    try { serverProcess?.kill(); } catch (_) { /* 已退出 */ }
    try {
        fs.rmSync(profile, { recursive: true, force: true });
    } catch (_) {
        // Electron 仍持有句柄时忽略，交给系统清理临时目录。
    }
    app.exit(code);
}

let serverProcess = null;
let serverUrl = '';
let cookie = '';
const timer = setTimeout(() => finish(1, 'FAIL 超时：90 秒内没有跑完端到端断言'), 90000);
timer.unref?.();

// configserver 以**独立进程**启动（就是它在服务器上的运行方式）：
// 走 `node server.mjs` + 环境变量配置，顺带验证 CLI 入口与默认路径。
function findFreePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

async function startConfigServer() {
    const port = await findFreePort();
    const dataDir = path.join(profile, 'configserver');
    serverProcess = spawn(process.execPath, [path.join(HERE, '..', 'configserver', 'server.mjs')], {
        env: {
            ...process.env,
            // process.execPath 是 electron，用这个开关让它以纯 Node 方式运行服务端。
            ELECTRON_RUN_AS_NODE: '1',
            CONFIG_HOST: '127.0.0.1',
            CONFIG_PORT: String(port),
            CONFIG_DATA_DIR: dataDir,
            CONFIG_ADMIN_PASSWORD: ADMIN_PASSWORD
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProcess.stdout.on('data', chunk => process.stdout.write(String(chunk)));
    serverProcess.stderr.on('data', chunk => process.stderr.write(String(chunk)));
    serverProcess.on('exit', code => {
        if (!settled) finish(1, `FAIL configserver 提前退出（code=${code}）`);
    });

    serverUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20000;
    for (;;) {
        try {
            const response = await fetch(`${serverUrl}/health`);
            if (response.ok) return serverUrl;
        } catch (_) {
            // 还没起来
        }
        if (Date.now() > deadline) throw new Error(`configserver 在 20 秒内没有就绪：${serverUrl}`);
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}

const READ_DOM = `(() => {
    const text = node => (node ? node.textContent : '');
    const settings = document.getElementById('modelConfigSettings');
    return {
        settingsMounted: Boolean(settings),
        settingsSummary: text(settings && settings.querySelector('[data-config-summary]')),
        settingsState: text(settings && settings.querySelector('[data-config-state]')),
        bridgeAvailable: typeof window.flowCanvas?.modelConfig?.fetch === 'function',
        videoPanel: text(document.getElementById('videoModelCapabilities')),
        imagePanel: text(document.getElementById('imageModelCapabilities')),
        videoPanelVisible: document.getElementById('videoModelCapabilities')?.hidden === false,
        videoDurationControl: text(document.getElementById('videoDurationControl')),
        ratioOptions: document.querySelectorAll('#videoRatioField .creation-ratio-grid button, #videoRatioField .creation-ratio-grid [role=radio]').length
    };
})()`;

async function readDom(win) {
    return win.webContents.executeJavaScript(READ_DOM);
}

// 轮询到条件满足为止，避免把启动/刷新竞态当成失败。
async function waitFor(win, predicate, { timeoutMs = 25000, intervalMs = 300, label = '条件' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
        last = await readDom(win);
        if (predicate(last)) return last;
        if (Date.now() > deadline) throw new Error(`等待「${label}」超时；最后一次 DOM：${JSON.stringify(last)}`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

async function adminLogin(base) {
    const response = await fetch(`${base}/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: ADMIN_PASSWORD }),
        redirect: 'manual'
    });
    if (response.status !== 303) throw new Error(`管理员登录失败：HTTP ${response.status}`);
    return (response.headers.get('set-cookie') || '').split(';')[0];
}

async function adminCsrf(base, cookie) {
    const html = await fetch(`${base}/admin`, { headers: { cookie } }).then(response => response.text());
    const token = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    if (!token) throw new Error('管理面板没有返回 CSRF token');
    return token;
}

async function adminPost(base, pathname, fields, cookie) {
    const response = await fetch(`${base}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: new URLSearchParams(fields),
        redirect: 'manual'
    });
    if (response.status !== 303) throw new Error(`管理操作 ${pathname} 失败：HTTP ${response.status}`);
    return decodeURIComponent(response.headers.get('location') || '');
}

let reloaded = false;

app.on('browser-window-created', (_event, win) => {
    win.hide();
    win.on('show', () => win.hide());
    win.webContents.on('did-finish-load', async () => {
        if (!/index\.html/i.test(win.webContents.getURL())) return;

        // 第一趟：等本地服务就绪，把更新源指过去再重载
        // （顺便验证「持久化的更新源在启动时生效」）。
        if (!reloaded) {
            reloaded = true;
            console.log('[smoke] 第一趟加载完成，等待 configserver 就绪…');
            serverReady
                .then(() => win.webContents.executeJavaScript(
                    `localStorage.setItem('flow-canvas-model-config-url-v1', ${JSON.stringify(`${serverUrl}/config`)});`
                ))
                .then(() => {
                    console.log(`[smoke] 已把更新源写入 localStorage，重载渲染层（${serverUrl}/config）`);
                    // 由主进程发起 reload：若让页面脚本自己 location.reload()，
                    // executeJavaScript 的 promise 会因为导航而被丢弃。
                    win.webContents.reload();
                })
                .catch(error => finish(1, `FAIL 无法写入本地更新源：${error?.message || error}`));
            return;
        }
        console.log('[smoke] 第二趟加载完成，开始断言');
        // 状态卡是折叠的 <details>：展开才会重绘摘要（这是刻意的省渲染设计），
        // 所以断言前先点开——顺便验证「展开即刷新状态」这条交互。
        await win.webContents.executeJavaScript(`document.querySelector('#modelConfigSettings summary').click();`);

        try {
            const problems = [];
            const expect = (ok, label) => { if (!ok) problems.push(label); };

            // ── 从服务器拉取并应用（启动时自动刷新）────────────────
            const applied = await waitFor(win, dom => (/已从服务器获取最新配置/.test(dom.settingsState) && /r1\b/.test(dom.settingsSummary)),
                { label: '客户端应用服务器配置 r1' });
            expect(applied.settingsMounted, '设置卡未挂载（initModelConfigUi 没跑到）');
            expect(/16 个模型/.test(applied.settingsSummary), `内置配置模型数异常：${applied.settingsSummary}`);
            expect(/自定义地址/.test(applied.settingsSummary), `更新源应显示为自定义地址：${applied.settingsSummary}`);
            expect(applied.bridgeAvailable, 'preload 未暴露 flowCanvas.modelConfig.fetch');
            expect(applied.videoPanelVisible, '视频能力面板没有显示');
            expect(/模型能力/.test(applied.videoPanel), `能力面板未渲染：${applied.videoPanel}`);
            expect(/RavenHash视频 · SD2.5线路一/.test(applied.videoPanel), '能力面板未显示命中线路');
            expect(/固定 30 秒/.test(applied.videoPanel), '能力面板未反映 CONFIG 的固定时长');
            expect(/最多 9 张参考图/.test(applied.videoPanel), '能力面板未反映参考图上限');
            expect(applied.videoPanel.includes(FINGERPRINT), '服务端配置的内容没有进入能力面板（远端配置未真正生效）');
            expect(/服务器/.test(applied.videoPanel), '能力面板来源未标为服务器');
            expect(applied.videoDurationControl.includes('30'), `既有控件未跟随 CONFIG：${applied.videoDurationControl}`);
            expect(applied.ratioOptions === 6, `比例控件数量异常：${applied.ratioOptions}`);
            if (problems.length) return finish(1, `FAIL 客户端应用服务端配置：\n  - ${problems.join('\n  - ')}\nDOM: ${JSON.stringify(applied, null, 2)}`);

            // ── 回滚到旧版本 → 界面点「立即刷新」→ 客户端跟着回退 ──
            const seedName = seedVersionName;
            await adminPost(serverUrl, '/admin/apply', { csrf: await adminCsrf(serverUrl, cookie), name: seedName }, cookie);
            await win.webContents.executeJavaScript(`document.querySelector('#modelConfigSettings [data-config="refresh"]').click();`);
            const rolledBack = await waitFor(win, dom => (/r0\b/.test(dom.settingsSummary) && !dom.videoPanel.includes(FINGERPRINT)),
                { label: '回滚后客户端刷新到 r0' });
            expect(/已从服务器获取最新配置/.test(rolledBack.settingsState), `回滚后状态异常：${rolledBack.settingsState}`);

            // ── IPC 拉取的三种结果 ────────────────────────────────
            const bridge = await win.webContents.executeJavaScript(`(async () => {
                const good = await window.flowCanvas.modelConfig.fetch({ url: '${serverUrl}/config' });
                const missing = await window.flowCanvas.modelConfig.fetch({ url: '${serverUrl}/config-missing' });
                const blocked = await window.flowCanvas.modelConfig.fetch({ url: 'file:///etc/passwd' });
                return {
                    goodSuccess: good?.success, goodRevision: good?.config?.revision, goodModels: good?.config?.models?.length,
                    missingSuccess: missing?.success, missingError: missing?.error,
                    blockedSuccess: blocked?.success, blockedError: blocked?.error
                };
            })()`);
            expect(bridge.goodSuccess === true, `合法配置未被接受：${JSON.stringify(bridge)}`);
            expect(bridge.goodRevision === 0, `回滚后的 revision 未透传：${bridge.goodRevision}`);
            expect(bridge.goodModels === 16, `模型数量异常：${bridge.goodModels}`);
            expect(bridge.missingSuccess === false && /HTTP 404/.test(String(bridge.missingError)), `404 未如实上报：${bridge.missingError}`);
            expect(bridge.blockedSuccess === false && /http:\/\/ 或 https:\/\//.test(String(bridge.blockedError)), `非 http(s) 地址未被拦下：${bridge.blockedError}`);

            if (problems.length) return finish(1, `FAIL 端到端断言：\n  - ${problems.join('\n  - ')}`);

            finish(0, [
                'PASS 模型 CONFIG 端到端烟测（真实 configserver + 真实 Electron 渲染层）',
                `  服务端：${serverUrl}/config（版本 ${seedName} 已回滚为现行 r0）`,
                `  首次拉取：r1 已应用到界面（能力面板出现指纹「${FINGERPRINT}」）`,
                `  回滚后：r0 生效，指纹消失`,
                `  IPC 结果：${JSON.stringify(bridge)}`,
                ''
            ].join('\n'));
        } catch (error) {
            finish(1, `FAIL 断言抛错：${error?.stack || error}`);
        }
    });
});

// 顺序很讲究（两个硬约束叠在一起）：
//   1. electron-main/main.js 必须在 app ready 之前被 require——它在模块顶层调用
//      protocol.registerSchemesAsPrivileged，晚了会直接抛错；
//   2. 客户端重载前 configserver 必须已就绪并发布好 r1。
// 所以：主进程同步 require；服务端在后台异步起，渲染层第一趟加载时 await 它的就绪 Promise。
let seedVersionName = '';
const serverReady = (async () => {
    await startConfigServer();

    // 通过管理接口发布 r1：只改一条 note 作为指纹，其余与内置默认一致。
    cookie = await adminLogin(serverUrl);
    const csrf = await adminCsrf(serverUrl, cookie);
    const baseline = await fetch(`${serverUrl}/config`).then(response => response.json());
    seedVersionName = JSON.parse(await (await fetch(`${serverUrl}/health`)).text()).current;
    const edited = JSON.parse(JSON.stringify(baseline));
    const route1 = edited.models.find(entry => entry.id === 'ravenhash-video.sd2.5-route1');
    route1.capabilities.face.note = `${route1.capabilities.face.note}（${FINGERPRINT}）`;
    await adminPost(serverUrl, '/admin/save', { csrf, content: JSON.stringify(edited), note: '烟测指纹' }, cookie);
    const published = await fetch(`${serverUrl}/config`).then(response => response.json());
    if (published.revision !== 1) throw new Error(`发布后 revision 应为 1，实际 ${published.revision}`);
    console.log(`[smoke] configserver 就绪：${serverUrl}（种子版本 ${seedVersionName}，已发布 r1）`);
    return serverUrl;
})();
serverReady.catch(error => finish(1, `FAIL 启动烟测环境失败：${error?.stack || error}`));

require('../electron-main/main.js');
