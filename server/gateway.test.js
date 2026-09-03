const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcanvas-gateway-'));
Object.assign(process.env, {
    FREE_UPSTREAM_URL: 'https://free.example/v1',
    FREE_UPSTREAM_KEY: 'free-chat-key',
    FREE_MODEL: 'free-chat-model',
    FREE_IMAGE_UPSTREAM_URL: 'https://free-media.example/v1',
    FREE_IMAGE_UPSTREAM_KEY: 'free-media-key',
    FREE_IMAGE_MODEL: 'free-image-model',
    FREE_VIDEO_MODEL: 'free-video-model',
    RAVENHASH_MODEL: 'ravenhash-chat-model',
    RAVENHASH_IMAGE_MODEL: 'ravenhash-image-model',
    RAVENHASH_VIDEO_MODEL: 'ravenhash-video-model',
    MEDIA_DIR: mediaDir,
    PUBLIC_MEDIA_BASE_URL: 'https://media.example',
    RAVENHASH_KEY_VALIDATION_PATH: 'models',
    MEDIA_UPLOAD_RATE_LIMIT_PER_HOUR: '50',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5180,null,file://'
});

const { app } = require('./index');

let server;
let port;
let upstreamCalls = [];
const originalFetch = global.fetch;

test.before(async () => {
    global.fetch = async (url, options = {}) => {
        const headers = new Headers(options.headers || {});
        let body = null;
        if (typeof options.body === 'string') {
            try { body = JSON.parse(options.body); } catch (_) { body = options.body; }
        }
        upstreamCalls.push({
            url: String(url),
            method: options.method || 'GET',
            authorization: headers.get('authorization'),
            contentType: headers.get('content-type'),
            body
        });

        if (String(url).endsWith('/models')) {
            const valid = headers.get('authorization') !== 'Bearer invalid-key';
            return new Response(JSON.stringify(valid ? { data: [] } : { error: 'invalid key' }), {
                status: valid ? 200 : 401,
                headers: { 'content-type': 'application/json' }
            });
        }
        if (String(url).endsWith('/chat/completions') && body?.stream) {
            const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
            return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        if (body?.prompt === 'echo-key-error') {
            return new Response(JSON.stringify({ error: `upstream echoed ${headers.get('authorization')}` }), {
                status: 400,
                headers: { 'content-type': 'application/json' }
            });
        }
        return new Response(JSON.stringify({ data: [{ url: 'https://result.example/output.png' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
    };
    await new Promise(resolve => {
        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            resolve();
        });
    });
});

test.after(async () => {
    global.fetch = originalFetch;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(mediaDir, { recursive: true, force: true });
});

function request(pathname, { method = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: pathname,
            method,
            headers
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed = null;
                if (text) {
                    try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
                }
                resolve({ status: res.statusCode, body: parsed, text, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function multipartBody(filename = 'test.png', contentType = 'image/png') {
    const boundary = `----flowcanvas-${filename.replace(/[^a-z0-9]/gi, '')}`;
    const body = Buffer.from([
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`,
        `Content-Type: ${contentType}\r\n\r\n`,
        'test-media-data',
        `\r\n--${boundary}--\r\n`
    ].join(''));
    return { boundary, body };
}

async function generateImage(baseUrl, apiKey = '') {
    upstreamCalls = [];
    const body = JSON.stringify({ prompt: 'test', model: 'client-model' });
    const response = await request('/v1/images/generations', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'x-flowcanvas-model-base-url': baseUrl,
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
        },
        body
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamCalls.length, 1);
    return upstreamCalls[0];
}

async function createVideo(baseUrl, apiKey = '') {
    upstreamCalls = [];
    const body = JSON.stringify({ prompt: 'test video', model: 'client-model' });
    const response = await request('/v1/videos', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'x-flowcanvas-model-base-url': baseUrl,
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
        },
        body
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamCalls.length, 1);
    return upstreamCalls[0];
}

test('routes non-whitelisted image requests only to the free upstream', async () => {
    for (const baseUrl of ['', 'https://example.com/v1', 'https://ai.ravenhash.org/v1?x=1']) {
        const call = await generateImage(baseUrl, 'must-not-reach-free-upstream');
        assert.equal(call.url, 'https://free-media.example/v1/images/generations');
        assert.equal(call.authorization, 'Bearer free-media-key');
        assert.equal(call.body.model, 'free-image-model');
    }
});

test('routes exact RavenHash image URLs with the user API Key', async () => {
    const aiCall = await generateImage('https://ai.ravenhash.org/v1', 'user-ai-key');
    assert.equal(aiCall.url, 'https://ai.ravenhash.org/v1/images/generations');
    assert.equal(aiCall.authorization, 'Bearer user-ai-key');
    assert.equal(aiCall.body.model, 'ravenhash-image-model');

    const artCall = await generateImage('https://art.ravenhash.org/v1/', 'user-art-key');
    assert.equal(artCall.url, 'https://art.ravenhash.org/v1/images/generations');
    assert.equal(artCall.authorization, 'Bearer user-art-key');
});

test('routes chat correctly and preserves streaming responses', async () => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], stream: true });

    upstreamCalls = [];
    const freeResponse = await request('/v1/chat/completions', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'x-flowcanvas-model-base-url': 'https://example.com/v1',
            authorization: 'Bearer must-not-reach-free-upstream'
        },
        body
    });
    assert.equal(freeResponse.status, 200);
    assert.match(freeResponse.text, /data:.*"ok"/);
    assert.equal(upstreamCalls[0].url, 'https://free.example/v1/chat/completions');
    assert.equal(upstreamCalls[0].authorization, 'Bearer free-chat-key');
    assert.equal(upstreamCalls[0].body.model, 'free-chat-model');

    upstreamCalls = [];
    const ravenhashResponse = await request('/v1/chat/completions', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'x-flowcanvas-model-base-url': 'HTTPS://AI.RavenHash.Org/v1',
            authorization: 'Bearer user-chat-key'
        },
        body
    });
    assert.equal(ravenhashResponse.status, 200);
    assert.match(ravenhashResponse.text, /data: \[DONE\]/);
    assert.equal(upstreamCalls[0].url, 'https://ai.ravenhash.org/v1/chat/completions');
    assert.equal(upstreamCalls[0].authorization, 'Bearer user-chat-key');
    assert.equal(upstreamCalls[0].body.model, 'ravenhash-chat-model');
});

test('applies the same whitelist boundary to video requests', async () => {
    const freeCall = await createVideo('https://video.example/v1');
    assert.equal(freeCall.url, 'https://free-media.example/v1/videos');
    assert.equal(freeCall.authorization, 'Bearer free-media-key');
    assert.equal(freeCall.body.model, 'free-video-model');

    const ravenhashCall = await createVideo('https://art.ravenhash.org/v1', 'user-video-key');
    assert.equal(ravenhashCall.url, 'https://art.ravenhash.org/v1/videos');
    assert.equal(ravenhashCall.authorization, 'Bearer user-video-key');
    assert.equal(ravenhashCall.body.model, 'ravenhash-video-model');
});

test('routes video polling, content, and remix operations', async () => {
    for (const pathname of ['/v1/videos/job-1', '/v1/videos/job-1/content']) {
        upstreamCalls = [];
        const response = await request(pathname, {
            headers: {
                'x-flowcanvas-model-base-url': 'https://art.ravenhash.org/v1',
                authorization: 'Bearer user-video-key'
            }
        });
        assert.equal(response.status, 200);
        assert.equal(upstreamCalls[0].url, `https://art.ravenhash.org${pathname}`);
        assert.equal(upstreamCalls[0].authorization, 'Bearer user-video-key');
    }

    upstreamCalls = [];
    const remixBody = JSON.stringify({ prompt: 'remix' });
    const remix = await request('/v1/videos/job-1/remix', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(remixBody),
            'x-flowcanvas-model-base-url': 'https://art.ravenhash.org/v1',
            authorization: 'Bearer user-video-key'
        },
        body: remixBody
    });
    assert.equal(remix.status, 200);
    assert.equal(upstreamCalls[0].url, 'https://art.ravenhash.org/v1/videos/job-1/remix');
    assert.equal(upstreamCalls[0].body.model, 'ravenhash-video-model');
});

test('routes multipart image edits without leaking free-route authorization', async () => {
    const { boundary, body } = multipartBody();
    upstreamCalls = [];
    const freeResponse = await request('/v1/images/edits', {
        method: 'POST',
        headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': body.length,
            'x-flowcanvas-model-base-url': 'https://example.com/v1',
            authorization: 'Bearer must-not-reach-free-upstream'
        },
        body
    });
    assert.equal(freeResponse.status, 200);
    assert.equal(upstreamCalls[0].url, 'https://free-media.example/v1/images/edits');
    assert.equal(upstreamCalls[0].authorization, 'Bearer free-media-key');

    upstreamCalls = [];
    const ravenhashResponse = await request('/v1/images/edits', {
        method: 'POST',
        headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': body.length,
            'x-flowcanvas-model-base-url': 'https://art.ravenhash.org/v1',
            authorization: 'Bearer user-edit-key'
        },
        body
    });
    assert.equal(ravenhashResponse.status, 200);
    assert.equal(upstreamCalls[0].url, 'https://art.ravenhash.org/v1/images/edits');
    assert.equal(upstreamCalls[0].authorization, 'Bearer user-edit-key');
});

test('routes files and multipart upload lifecycle paths', async () => {
    const { boundary, body } = multipartBody('source.png');
    const cases = [
        { method: 'POST', path: '/v1/files', expected: 'files', contentType: `multipart/form-data; boundary=${boundary}`, body },
        { method: 'GET', path: '/v1/files/file-1/content', expected: 'files/file-1/content' },
        { method: 'POST', path: '/v1/uploads/upload-1/parts', expected: 'uploads/upload-1/parts', contentType: `multipart/form-data; boundary=${boundary}`, body },
        { method: 'POST', path: '/v1/uploads/upload-1/complete', expected: 'uploads/upload-1/complete', contentType: 'application/json', body: Buffer.from('{}') },
        { method: 'DELETE', path: '/v1/uploads/upload-1/cancel', expected: 'uploads/upload-1/cancel' }
    ];

    for (const item of cases) {
        upstreamCalls = [];
        const response = await request(item.path, {
            method: item.method,
            headers: {
                ...(item.contentType ? { 'content-type': item.contentType } : {}),
                ...(item.body ? { 'content-length': item.body.length } : {}),
                'x-flowcanvas-model-base-url': 'https://art.ravenhash.org/v1',
                authorization: 'Bearer user-file-key'
            },
            body: item.body
        });
        assert.equal(response.status, 200, item.path);
        assert.equal(upstreamCalls[0].url, `https://art.ravenhash.org/v1/${item.expected}`);
        assert.equal(upstreamCalls[0].authorization, 'Bearer user-file-key');
    }

    upstreamCalls = [];
    const freeResponse = await request('/v1/files', {
        method: 'POST',
        headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': body.length,
            'x-flowcanvas-model-base-url': 'https://files.example/v1',
            authorization: 'Bearer must-not-reach-free-upstream'
        },
        body
    });
    assert.equal(freeResponse.status, 200);
    assert.equal(upstreamCalls[0].url, 'https://free-media.example/v1/files');
    assert.equal(upstreamCalls[0].authorization, 'Bearer free-media-key');
});

test('rejects RavenHash requests without a user API Key', async () => {
    const body = JSON.stringify({ prompt: 'test' });
    const response = await request('/v1/images/generations', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'x-flowcanvas-model-base-url': 'https://ai.ravenhash.org/v1'
        },
        body
    });
    assert.equal(response.status, 401);
});

test('redacts the user API Key from upstream error details', async () => {
    const body = JSON.stringify({ prompt: 'echo-key-error' });
    const response = await request('/v1/images/generations', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'x-flowcanvas-model-base-url': 'https://art.ravenhash.org/v1',
            authorization: 'Bearer user-secret-key'
        },
        body
    });
    assert.equal(response.status, 400);
    assert.doesNotMatch(response.text, /user-secret-key/);
    assert.match(response.body.detail, /\[redacted\]/);
});

test('allows material URL uploads only for RavenHash routes', async () => {
    const denied = await request('/api/media/upload', {
        method: 'POST',
        headers: { 'x-flowcanvas-model-base-url': 'https://example.com/v1' }
    });
    assert.equal(denied.status, 403);

    const { boundary, body } = multipartBody();
    const invalid = await request('/api/media/upload', {
        method: 'POST',
        headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': body.length,
            'x-flowcanvas-model-base-url': 'https://art.ravenhash.org/v1',
            authorization: 'Bearer invalid-key'
        },
        body
    });
    assert.equal(invalid.status, 401);

    const allowed = await request('/api/media/upload', {
        method: 'POST',
        headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': body.length,
            'x-flowcanvas-model-base-url': 'https://art.ravenhash.org/v1',
            authorization: 'Bearer user-upload-key'
        },
        body
    });
    assert.equal(allowed.status, 201);
    assert.match(allowed.body.url, /^https:\/\/media\.example\/media\/[0-9a-f-]{36}\.png$/);
});

test('rejects browser origins outside the configured CORS allowlist', async () => {
    const response = await request('/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(response.status, 403);
});

test('allows configured CORS preflight headers', async () => {
    const response = await request('/v1/chat/completions', {
        method: 'OPTIONS',
        headers: {
            origin: 'http://localhost:5180',
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type,x-flowcanvas-model-base-url'
        }
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:5180');
    assert.match(response.headers['access-control-allow-headers'], /X-FlowCanvas-Model-Base-URL/i);
});

test('rejects oversized non-media requests before reading the body', async () => {
    const body = Buffer.alloc(2 * 1024 * 1024 + 1, 'x');
    const response = await request('/v1/chat/completions', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'content-length': body.length
        },
        body
    });
    assert.equal(response.status, 413);
    assert.equal(response.body.error, '请求体过大');
});

test('rejects API Keys above the documented length limit', async () => {
    const response = await request('/v1/images/generations', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${'x'.repeat(4097)}`,
            'x-flowcanvas-model-base-url': 'https://art.ravenhash.org/v1'
        }
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /4096/);
});
