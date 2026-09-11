import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AUTH_LIMITS,
    createAuth,
    hashPassword,
    parseCookies,
    serializeCookie,
    verifyPassword
} from './lib/auth.mjs';

test('密码只以 scrypt 哈希形式存在，比较用 timingSafeEqual', () => {
    const record = hashPassword('correct horse battery');
    assert.equal(record.algorithm, 'scrypt');
    assert.equal(record.hash.length, 128);
    assert.equal(JSON.stringify(record).includes('correct horse battery'), false, '哈希里不能出现明文');
    assert.equal(verifyPassword('correct horse battery', record), true);
    assert.equal(verifyPassword('wrong password', record), false);
    assert.equal(verifyPassword('', record), false);
    assert.equal(verifyPassword('correct horse battery', null), false);
    assert.equal(verifyPassword('correct horse battery', { salt: 'x' }), false);
    // 同一密码两次哈希的 salt 不同 → 哈希值不同（防彩虹表）
    assert.notEqual(hashPassword('correct horse battery').hash, record.hash);
    assert.throws(() => hashPassword('short'), /至少 8 位/);
});

test('登录成功发会话，登录失败不发；密码错误与限流报错可区分', () => {
    const auth = createAuth({ passwordRecord: hashPassword('s3cret-password'), logger: { warn() {}, log() {} } });
    const ok = auth.login('s3cret-password', { ip: '10.0.0.1' });
    assert.equal(ok.ok, true);
    assert.ok(ok.token && ok.token.length >= 32);
    assert.ok(auth.session(ok.token), '会话应可校验');
    assert.ok(auth.session(ok.token).csrf, '会话需要带 CSRF token');

    const bad = auth.login('nope', { ip: '10.0.0.2' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /密码不正确/);
    assert.equal(bad.retryAfter, undefined);
});

test('会话有 TTL 且滑动续期；退出后失效', () => {
    let clock = 1_000_000;
    const auth = createAuth({ passwordRecord: hashPassword('s3cret-password'), now: () => clock, logger: { warn() {} } });
    const { token } = auth.login('s3cret-password', { ip: '10.0.0.1' });

    clock += AUTH_LIMITS.SESSION_TTL_MS - 1000;
    assert.ok(auth.session(token), 'TTL 内应有效');

    // 滑动续期：刚访问过，再等一个 TTL 仍然有效
    clock += AUTH_LIMITS.SESSION_TTL_MS - 1000;
    assert.ok(auth.session(token));

    clock += AUTH_LIMITS.SESSION_TTL_MS + 1;
    assert.equal(auth.session(token), null, '超过 TTL 应失效');

    const second = auth.login('s3cret-password', { ip: '10.0.0.1' });
    auth.logout(second.token);
    assert.equal(auth.session(second.token), null);
    assert.equal(auth.sessionCount(), 0);
});

test('连续失败触发按 IP 限流，其它 IP 不受影响', () => {
    const warnings = [];
    const auth = createAuth({ passwordRecord: hashPassword('s3cret-password'), logger: { warn: message => warnings.push(message) } });
    for (let attempt = 1; attempt < AUTH_LIMITS.MAX_FAILURES; attempt += 1) {
        assert.equal(auth.login('bad', { ip: '10.1.1.1' }).retryAfter, undefined, `第 ${attempt} 次不该被封`);
    }
    auth.login('bad', { ip: '10.1.1.1' }); // 第 MAX_FAILURES 次失败，此刻起进入封禁窗口
    // 被封期间即使密码正确也拒绝，并告知重试时间
    const stillBlocked = auth.login('s3cret-password', { ip: '10.1.1.1' });
    assert.equal(stillBlocked.ok, false);
    assert.ok(stillBlocked.retryAfter > 0);
    // 其它 IP 不受影响
    assert.equal(auth.login('s3cret-password', { ip: '10.9.9.9' }).ok, true);
    assert.ok(warnings.some(message => message.includes('登录失败次数过多')));
});

test('cookie 解析与序列化：HttpOnly + SameSite=Strict + 可选 Secure', () => {
    const cookie = serializeCookie('flow_config_session', 'tok en/+', { maxAgeSeconds: 3600, secure: true });
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Max-Age=3600/);
    const parsed = parseCookies(`a=1; flow_config_session=${encodeURIComponent('tok en/+')}; b=2`);
    assert.equal(parsed.get('flow_config_session'), 'tok en/+');
    assert.equal(parseCookies('').size, 0);
    assert.match(serializeCookie('x', '', { maxAgeSeconds: 0 }), /Max-Age=0/);
});
