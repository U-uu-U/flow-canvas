// artconfig.ravenhash.org 的模型能力 CONFIG 服务。
//
//   GET  /config                公开只读：返回现行 CONFIG（客户端就是拉这个地址）
//   GET  /health                健康检查
//   GET  /                      落地页：现行版本摘要 + 入口
//   GET  /admin                 管理面板（需登录）
//   GET  /admin/login           登录页
//   POST /admin/login           校验密码 → 种会话 cookie
//   POST /admin/logout
//   POST /admin/save            校验并保存为新版本（文件名带时间戳），可同时切换现行
//   POST /admin/apply           一键把某个旧版本切回现行（只改指针，不动文件）
//   POST /admin/delete          删除非现行版本
//   POST /admin/validate        只校验不保存（编辑器里的 AJAX）
//   GET  /admin/download?name=  下载某个版本原始 JSON
//
// 设计取舍：
//   · 零框架、零构建：只用 node:http + 原生模块，拷到服务器 `node server.mjs` 就能跑；
//     唯一可选依赖是 ajv（用于跑客户端那份 JSON Schema，装了才有完整校验）。
//   · 默认只监听 127.0.0.1：TLS 与域名交给前面的 nginx/caddy 反代，进程本身不直接暴露。
//   · 所有写操作都要「会话 cookie + CSRF token + Origin 同源」三件套。
//   · /config 带 ETag：客户端暂时不发 If-None-Match，但 CDN/反代可以据此省流量。
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createConfigStore } from './lib/store.mjs';
import { createValidator } from './lib/validate.mjs';
import { createAuth, hashPassword, parseCookies, serializeCookie, SESSION_COOKIE, AUTH_LIMITS } from './lib/auth.mjs';
import { adminPage, loginPage, landingPage, escapeHtml } from './lib/pages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_PORT = 8087;

export function resolveServerConfig(env = process.env) {
    const dataDir = path.resolve(env.CONFIG_DATA_DIR || path.join(HERE, 'data'));
    return {
        host: env.CONFIG_HOST || '127.0.0.1',
        port: Number(env.CONFIG_PORT || DEFAULT_PORT),
        dataDir,
        seedPath: env.CONFIG_SEED_PATH || path.join(HERE, 'seed', 'model-config.default.json'),
        schemaPath: env.CONFIG_SCHEMA_PATH || path.join(HERE, 'schema', 'model-config.schema.json'),
        adminPassword: env.CONFIG_ADMIN_PASSWORD || '',
        adminPasswordHash: env.CONFIG_ADMIN_PASSWORD_HASH || '',
        publicOrigin: (env.CONFIG_PUBLIC_ORIGIN || '').replace(/\/+$/, ''),
        trustedOrigin: env.CONFIG_TRUSTED_ORIGIN || '',
        tlsCert: env.CONFIG_TLS_CERT || '',
        tlsKey: env.CONFIG_TLS_KEY || '',
        cookieSecure: env.CONFIG_COOKIE_SECURE === '1',
        readAdminFile: () => {
            try {
                return JSON.parse(fs.readFileSync(path.join(dataDir, 'admin.json'), 'utf8'));
            } catch (_) {
                return null;
            }
        }
    };
}

// 密码优先级：环境变量明文 > 环境变量哈希 > data/admin.json
export function resolvePasswordRecord(config, env = process.env) {
    if (config.adminPassword) return hashPassword(config.adminPassword);
    if (config.adminPasswordHash) {
        try {
            const record = JSON.parse(config.adminPasswordHash);
            if (record?.hash && record?.salt) return record;
            throw new Error('缺少 hash/salt');
        } catch (error) {
            throw new Error(`CONFIG_ADMIN_PASSWORD_HASH 不是合法的哈希 JSON：${error.message}（可用 node server.mjs --hash-password 生成）`);
        }
    }
    const file = config.readAdminFile?.();
    if (file?.hash && file?.salt) return file;
    return null;
}

function json(res, status, payload, extraHeaders = {}) {
    const body = `${JSON.stringify(payload)}\n`;
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        ...extraHeaders
    });
    res.end(body);
}

function html(res, status, body, extraHeaders = {}) {
    res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'referrer-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        ...extraHeaders
    });
    res.end(body);
}

function redirect(res, location, extraHeaders = {}) {
    res.writeHead(303, { location, ...extraHeaders });
    res.end();
}

function clientIp(req) {
    return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || req.socket?.remoteAddress
        || 'unknown';
}

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new Error(`请求体超过 ${Math.round(MAX_BODY_BYTES / 1024)}KB`);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function parseForm(text) {
    const params = new URLSearchParams(text);
    const result = {};
    for (const [key, value] of params) result[key] = value;
    return result;
}

function sameOrigin(req, config) {
    const origin = req.headers.origin;
    if (!origin) return true; // 同源表单/curl 不带 Origin，交给 cookie + CSRF 判定
    try {
        const parsed = new URL(origin);
        const allowedHosts = new Set([req.headers.host, config.trustedOrigin && new URL(config.trustedOrigin).host,
            config.publicOrigin && new URL(config.publicOrigin).host].filter(Boolean));
        return allowedHosts.has(parsed.host) && ['http:', 'https:'].includes(parsed.protocol);
    } catch (_) {
        return false;
    }
}

/**
 * 启动服务。返回 { port, url, close(), store, validator }，便于测试里直接拿到端口。
 */
export async function createConfigServer(options = {}) {
    const env = options.env || process.env;
    const config = { ...resolveServerConfig(env), ...options };
    const logger = options.logger || console;
    const passwordRecord = options.passwordRecord || resolvePasswordRecord(config, env);
    if (!passwordRecord) {
        throw new Error('未配置管理密码：请设置 CONFIG_ADMIN_PASSWORD，或运行 `node server.mjs --hash-password` 后把结果写入 <data>/admin.json');
    }

    const store = options.store || createConfigStore({
        dataDir: config.dataDir,
        seedPath: config.seedPath,
        logger
    });
    store.ensureSeed();
    const validator = options.validator || await createValidator({ schemaPath: config.schemaPath });
    const auth = createAuth({ passwordRecord, logger });
    const startedAt = Date.now();

    if (validator.mode !== 'schema') {
        logger.warn(`[configserver] ${validator.note}（建议在 configserver 目录执行 npm install 装上 ajv）`);
    }

    function wantsJson(req) {
        const accept = String(req.headers.accept || '');
        return accept.includes('application/json') && !accept.includes('text/html');
    }

    function currentSession(req) {
        const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
        return { token, session: auth.session(token) };
    }

    function requireAdmin(req, res) {
        const { token, session } = currentSession(req);
        if (!session) {
            if (wantsJson(req)) json(res, 401, { success: false, error: '未登录' });
            else redirect(res, '/admin/login');
            return null;
        }
        return { token, session };
    }

    function requireCsrf(req, res, form) {
        const { session } = currentSession(req);
        const provided = form?.csrf || req.headers['x-csrf-token'] || '';
        if (!session || !provided || provided !== session.csrf) {
            json(res, 403, { success: false, error: 'CSRF 校验失败，请刷新页面后重试' });
            return false;
        }
        return true;
    }

    function handleConfig(req, res) {
        const active = store.current();
        if (!active) {
            json(res, 404, { success: false, error: '尚未发布任何 CONFIG 版本' });
            return;
        }
        const etag = `"${crypto.createHash('sha256').update(active.text).digest('hex').slice(0, 32)}"`;
        if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { etag, 'cache-control': 'no-cache' });
            res.end();
            return;
        }
        res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(active.text),
            'cache-control': 'no-cache',
            etag,
            // /config 是设计上公开的只读接口，放开 CORS 方便浏览器/调试工具直接查看。
            'access-control-allow-origin': '*'
        });
        res.end(active.text);
    }

    function renderAdmin(res, { csrf = '', flash = '', error = '', requestedVersion = '' } = {}) {
        let editorText = '';
        let editingName = '';
        try {
            if (requestedVersion && requestedVersion !== 'current') {
                const file = store.read(requestedVersion);
                editorText = file.text;
                editingName = file.name;
            } else {
                const active = store.current();
                if (active) {
                    editorText = active.text;
                    editingName = active.name;
                }
            }
        } catch (readError) {
            error = error || `无法读取版本：${readError.message}`;
        }
        html(res, 200, adminPage({
            versions: store.list(),
            current: store.current(),
            editorText,
            editing: editingName,
            history: store.history(50),
            flash,
            error,
            csrf,
            validatorMode: validator.mode,
            validatorNote: validator.mode === 'schema' ? '' : `${validator.note}：当前只做结构校验，强烈建议安装 ajv。`,
            publicConfigPath: '/config',
            publicOrigin: config.publicOrigin
        }));
    }

    async function route(req, res) {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = url.pathname.replace(/\/+$/, '') || '/';
        const method = req.method || 'GET';

        if (method === 'GET' && pathname === '/config') return handleConfig(req, res);
        if (method === 'GET' && pathname === '/health') {
            return json(res, 200, {
                ok: true,
                current: store.current()?.name || null,
                versions: store.list().length,
                validator: validator.mode,
                uptimeSeconds: Math.round((Date.now() - startedAt) / 1000)
            });
        }
        if (method === 'GET' && pathname === '/') {
            return html(res, 200, landingPage({ current: store.current(), publicConfigPath: '/config', adminPath: '/admin' }));
        }
        if (method === 'GET' && pathname === '/admin/login') {
            const code = url.searchParams.get('error');
            const message = code === '2' ? '尝试过于频繁，请稍后再试' : (code === '1' ? '密码不正确' : '');
            return html(res, 200, loginPage({ error: message }));
        }
        if (method === 'POST' && pathname === '/admin/login') {
            const body = await readBody(req);
            const form = parseForm(body);
            const result = auth.login(form.password || '', { ip: clientIp(req) });
            if (!result.ok) {
                logger.warn(`[configserver] 登录失败 ip=${clientIp(req)}：${result.error}`);
                return redirect(res, `/admin/login?error=${result.retryAfter ? 2 : 1}`);
            }
            const secure = config.cookieSecure || Boolean(config.tlsKey) || String(req.headers['x-forwarded-proto'] || '') === 'https';
            logger.log(`[configserver] 登录成功 ip=${clientIp(req)}`);
            return redirect(res, '/admin', {
                'set-cookie': serializeCookie(SESSION_COOKIE, result.token, {
                    maxAgeSeconds: Math.floor(AUTH_LIMITS.SESSION_TTL_MS / 1000),
                    secure
                })
            });
        }
        if (method === 'POST' && pathname === '/admin/logout') {
            const form = parseForm(await readBody(req));
            if (!requireCsrf(req, res, form)) return;
            auth.logout(parseCookies(req.headers.cookie).get(SESSION_COOKIE));
            return redirect(res, '/admin/login', { 'set-cookie': serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0 }) });
        }
        if (method === 'GET' && pathname === '/admin') {
            const guard = requireAdmin(req, res);
            if (!guard) return;
            return renderAdmin(res, {
                csrf: guard.session.csrf,
                flash: url.searchParams.get('flash') || '',
                requestedVersion: url.searchParams.get('version') || ''
            });
        }
        if (method === 'GET' && pathname === '/admin/download') {
            if (!requireAdmin(req, res)) return;
            const name = url.searchParams.get('name') || '';
            try {
                const file = store.read(name);
                res.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    'content-disposition': `attachment; filename="${name}"`,
                    'content-length': Buffer.byteLength(file.text)
                });
                res.end(file.text);
            } catch (error) {
                return json(res, 404, { success: false, error: error.message });
            }
            return;
        }
        if (method === 'POST' && pathname === '/admin/validate') {
            if (!requireAdmin(req, res)) return;
            if (!requireCsrf(req, res, null)) return;
            const body = await readBody(req);
            const result = validator.validate(body);
            return json(res, 200, {
                ok: result.ok,
                errors: result.errors,
                mode: result.mode,
                modelCount: result.config?.models?.length || 0
            });
        }
        if (method === 'POST' && pathname === '/admin/save') {
            const guard = requireAdmin(req, res);
            if (!guard) return;
            if (!sameOrigin(req, config)) return json(res, 403, { success: false, error: 'Origin 校验失败' });
            const form = parseForm(await readBody(req));
            if (!requireCsrf(req, res, form)) return;
            const result = validator.validate(form.content || '');
            if (!result.ok) {
                logger.warn(`[configserver] 保存被拒绝：校验未通过（${result.errors.length} 项）`);
                return html(res, 400, adminPage({
                    versions: store.list(),
                    current: store.current(),
                    editorText: String(form.content || ''),
                    editing: form.basedOn || '',
                    history: store.history(50),
                    error: `保存失败，配置未通过校验（${result.mode} 模式）：${result.errors.slice(0, 6).join('；')}`,
                    csrf: guard.session.csrf,
                    validatorMode: validator.mode,
                    validatorNote: validator.mode === 'schema' ? '' : `${validator.note}：当前只做结构校验，建议安装 ajv。`,
                    publicOrigin: config.publicOrigin
                }));
            }
            const applied = form.draft !== '1';
            const saved = store.save(result.config, {
                actor: `admin@${clientIp(req)}`,
                apply: applied,
                note: form.note || ''
            });
            logger.log(`[configserver] 已保存版本 ${saved.name}（r${saved.revision}${applied ? '，已切换现行' : '，未切换现行'}）`);
            return redirect(res, `/admin?flash=${encodeURIComponent(applied
                ? `已保存并应用 r${saved.revision}（${saved.name}）`
                : `已保存 r${saved.revision}（${saved.name}），现行版本未改变`)}`);
        }
        if (method === 'POST' && pathname === '/admin/apply') {
            const guard = requireAdmin(req, res);
            if (!guard) return;
            if (!sameOrigin(req, config)) return json(res, 403, { success: false, error: 'Origin 校验失败' });
            const form = parseForm(await readBody(req));
            if (!requireCsrf(req, res, form)) return;
            try {
                const result = store.apply(form.name, { actor: `admin@${clientIp(req)}`, note: form.note || '' });
                logger.log(`[configserver] 已把现行版本切换为 ${result.name}（r${result.revision}），原现行 ${result.previous || '无'}`);
                return redirect(res, `/admin?flash=${encodeURIComponent(`已应用 ${result.name}（r${result.revision}）为现行版本`)}`);
            } catch (error) {
                return redirect(res, `/admin?flash=${encodeURIComponent(`应用失败：${error.message}`)}`);
            }
        }
        if (method === 'POST' && pathname === '/admin/delete') {
            const guard = requireAdmin(req, res);
            if (!guard) return;
            if (!sameOrigin(req, config)) return json(res, 403, { success: false, error: 'Origin 校验失败' });
            const form = parseForm(await readBody(req));
            if (!requireCsrf(req, res, form)) return;
            try {
                store.remove(form.name, { actor: `admin@${clientIp(req)}` });
                return redirect(res, `/admin?flash=${encodeURIComponent(`已删除版本 ${form.name}`)}`);
            } catch (error) {
                return redirect(res, `/admin?flash=${encodeURIComponent(`删除失败：${error.message}`)}`);
            }
        }
        if (method === 'OPTIONS') {
            res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' });
            res.end();
            return;
        }
        return html(res, 404, landingPage({ current: store.current() }));
    }

    const handler = (req, res) => {
        const started = Date.now();
        const pathname = String(req.url || '').split('?')[0];
        res.on('finish', () => {
            // 只记路径，不记 cookie / 请求体 / 密码
            logger.log(`[configserver] ${req.method} ${pathname} → ${res.statusCode} ${Date.now() - started}ms ip=${clientIp(req)}`);
        });
        route(req, res).catch(error => {
            logger.error(`[configserver] 处理 ${pathname} 失败：`, error);
            if (res.headersSent) {
                res.end();
                return;
            }
            // 对外只给可读信息，不吐堆栈（堆栈只进日志）。
            if (String(pathname).startsWith('/admin')) {
                html(res, 500, `<div style="font:14px sans-serif;padding:24px">服务内部错误：${escapeHtml(error.message)}</div>`);
            } else {
                json(res, 500, { success: false, error: '服务内部错误' });
            }
        });
    };

    const useTls = Boolean(config.tlsKey && config.tlsCert);
    const server = useTls
        ? https.createServer({ key: fs.readFileSync(config.tlsKey), cert: fs.readFileSync(config.tlsCert) }, handler)
        : http.createServer(handler);

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number(config.port) || 0, config.host, () => {
            server.off('error', reject);
            resolve();
        });
    });

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : Number(config.port);
    const scheme = useTls ? 'https' : 'http';
    const url = `${scheme}://${config.host}:${port}`;
    logger.log(`[configserver] 已启动 ${url}（数据目录 ${config.dataDir}，校验模式 ${validator.mode}）`);
    logger.log(`[configserver] 客户端地址 ${config.publicOrigin || url}/config · 管理面板 ${config.publicOrigin || url}/admin`);

    return {
        server,
        port,
        url,
        store,
        validator,
        config,
        auth,
        close: () => new Promise(resolve => server.close(() => resolve()))
    };
}

// ── CLI ──────────────────────────────────────────────────────
async function main(argv) {
    const env = process.env;
    if (argv.includes('--hash-password')) {
        let password = String(env.CONFIG_ADMIN_PASSWORD || '');
        if (!password) {
            const { createInterface } = await import('node:readline/promises');
            process.stdout.write('请输入管理密码（≥8 位，输入不显示）：');
            const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
            // 遮掉回显：把 readline 的逐字符输出替换成 '*'
            const originalWrite = rl._writeToOutput.bind(rl);
            rl._writeToOutput = text => {
                if (String(text).includes('\n') || String(text).includes('\r')) originalWrite(text);
                else rl.output.write('*');
            };
            password = String(await rl.question('')).trim();
            rl.close();
            process.stdout.write('\n');
        }
        if (password.length < 8) {
            console.error('密码至少 8 位。');
            process.exitCode = 1;
            return;
        }
        const record = hashPassword(password);
        const target = path.join(path.resolve(env.CONFIG_DATA_DIR || path.join(HERE, 'data')), 'admin.json');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        console.log(`已写入 ${target}（这是唯一的密码凭据文件，请确保它不在版本库里）`);
        console.log('也可以改用环境变量、完全不落盘：');
        console.log(`CONFIG_ADMIN_PASSWORD_HASH='${JSON.stringify(record)}'`);
        return;
    }

    const instance = await createConfigServer({});
    const shutdown = async signal => {
        console.log(`[configserver] 收到 ${signal}，正在关闭…`);
        await instance.close();
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    main(process.argv.slice(2)).catch(error => {
        console.error(`[configserver] 启动失败：${error.message}`);
        process.exitCode = 1;
    });
}
