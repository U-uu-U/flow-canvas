// 管理面板鉴权。
//
// 三条底线：
//   1. 仓库里不存明文密码——只存 scrypt 哈希（salt 随机），或从环境变量读明文后即时哈希；
//   2. 比较用 timingSafeEqual，避免按字节比较泄漏信息；
//   3. 登录失败按 IP 限流，且没有配置密码时**拒绝启动**（fail closed），
//      避免有人忘了设密码就把管理面板挂到公网。
import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_COOKIE = 'flow_config_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

export function hashPassword(password, { salt = crypto.randomBytes(16).toString('hex') } = {}) {
    const value = String(password ?? '');
    if (value.length < 8) throw new Error('管理密码至少 8 位');
    const hash = crypto.scryptSync(value, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
    return { algorithm: 'scrypt', ...SCRYPT, salt, hash };
}

export function verifyPassword(password, record) {
    if (!record || typeof record.hash !== 'string' || typeof record.salt !== 'string') return false;
    try {
        const expected = Buffer.from(record.hash, 'hex');
        const actual = crypto.scryptSync(String(password ?? ''), record.salt, expected.length, {
            N: Number(record.N) || SCRYPT.N,
            r: Number(record.r) || SCRYPT.r,
            p: Number(record.p) || SCRYPT.p
        });
        return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch (_) {
        return false;
    }
}

export function parseCookies(header) {
    const cookies = new Map();
    for (const part of String(header || '').split(';')) {
        const index = part.indexOf('=');
        if (index < 0) continue;
        const name = part.slice(0, index).trim();
        if (name) cookies.set(name, decodeURIComponent(part.slice(index + 1).trim()));
    }
    return cookies;
}

export function serializeCookie(name, value, { maxAgeSeconds = 0, secure = false } = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
    if (secure) parts.push('Secure');
    parts.push(maxAgeSeconds > 0 ? `Max-Age=${Math.floor(maxAgeSeconds)}` : 'Max-Age=0');
    return parts.join('; ');
}

export function createAuth({ passwordRecord, now = () => Date.now(), logger = console } = {}) {
    if (!passwordRecord) throw new Error('createAuth 需要密码哈希（请先设置 CONFIG_ADMIN_PASSWORD 或 data/admin.json）');
    const sessions = new Map();
    const failures = new Map(); // ip → { count, firstAt, blockedUntil }

    function failureState(ip) {
        const record = failures.get(ip);
        if (!record) return null;
        if (now() - record.firstAt > FAILURE_WINDOW_MS) {
            failures.delete(ip);
            return null;
        }
        return record;
    }

    function retryAfterSeconds(ip) {
        const record = failureState(ip);
        if (!record?.blockedUntil) return 0;
        return Math.max(0, Math.ceil((record.blockedUntil - now()) / 1000));
    }

    function registerFailure(ip) {
        const record = failureState(ip) || { count: 0, firstAt: now(), blockedUntil: 0 };
        record.count += 1;
        if (record.count >= MAX_FAILURES) {
            record.blockedUntil = now() + FAILURE_WINDOW_MS;
            logger.warn(`[configserver] 登录失败次数过多，已暂时封禁 ${ip}（${MAX_FAILURES} 次/${FAILURE_WINDOW_MS / 60000} 分钟）`);
        }
        failures.set(ip, record);
    }

    function login(password, { ip = 'unknown' } = {}) {
        const wait = retryAfterSeconds(ip);
        if (wait > 0) return { ok: false, error: `尝试过于频繁，请 ${wait} 秒后再试`, retryAfter: wait };
        if (!verifyPassword(password, passwordRecord)) {
            registerFailure(ip);
            return { ok: false, error: '密码不正确' };
        }
        const token = crypto.randomBytes(32).toString('base64url');
        // csrf 与 session 绑定：即使浏览器被诱导发起跨站表单，攻击者也拿不到这个值。
        sessions.set(token, { ip, createdAt: now(), expiresAt: now() + SESSION_TTL_MS, csrf: crypto.randomBytes(16).toString('hex') });
        failures.delete(ip);
        return { ok: true, token, expiresAt: now() + SESSION_TTL_MS };
    }

    function session(token) {
        if (!token) return null;
        const record = sessions.get(token);
        if (!record) return null;
        if (record.expiresAt <= now()) {
            sessions.delete(token);
            return null;
        }
        record.expiresAt = now() + SESSION_TTL_MS; // 滑动续期：管理员连续操作不会被踢
        return record;
    }

    function logout(token) {
        if (token) sessions.delete(token);
        return { ok: true };
    }

    function sessionCount() {
        return sessions.size;
    }

    return { login, session, logout, retryAfterSeconds, sessionCount, cookieName: SESSION_COOKIE, ttlMs: SESSION_TTL_MS };
}

export const AUTH_LIMITS = { MAX_FAILURES, FAILURE_WINDOW_MS, SESSION_TTL_MS };
