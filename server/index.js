require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { Readable } = require('stream');
const { matchRavenhashBaseUrl } = require('./routing');
const createLogger = require('../shared/logger');
const constants = require('./constants');

const logger = createLogger('Gateway');

// 环境变量验证
function validateEnv(env = process.env) {
    const required = ['FREE_UPSTREAM_URL', 'FREE_UPSTREAM_KEY', 'FREE_MODEL'];
    const missing = required.filter(key => !env[key]);
    if (missing.length > 0) {
        throw new Error(`缺少必需环境变量: ${missing.join(', ')}`);
    }

    for (const name of ['FREE_UPSTREAM_URL', 'FREE_IMAGE_UPSTREAM_URL', 'PUBLIC_MEDIA_BASE_URL']) {
        if (!env[name]) continue;
        let parsed;
        try {
            parsed = new URL(env[name]);
        } catch (_) {
            throw new Error(`${name} 必须是有效 URL`);
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
            || parsed.search || parsed.hash) {
            throw new Error(`${name} 必须是无内嵌凭证、查询参数或锚点的 HTTP(S) URL`);
        }
    }

    const positiveNumbers = [
        'MAX_JSON_BODY_BYTES', 'MAX_MEDIA_UPLOAD_BYTES', 'MEDIA_TTL_HOURS',
        'UPSTREAM_TIMEOUT_MS', 'RAVENHASH_KEY_VALIDATION_TIMEOUT_MS',
        'RAVENHASH_KEY_VALIDATION_CACHE_MS', 'MEDIA_UPLOAD_RATE_LIMIT_PER_HOUR'
    ];
    for (const name of positiveNumbers) {
        if (env[name] === undefined || env[name] === '') continue;
        const value = Number(env[name]);
        if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须是正数`);
    }
}

const PORT = Number(process.env.PORT || 8787);
const FREE_UPSTREAM_URL = process.env.FREE_UPSTREAM_URL;
const FREE_UPSTREAM_KEY = process.env.FREE_UPSTREAM_KEY;
const FREE_MODEL = process.env.FREE_MODEL;
const FREE_IMAGE_UPSTREAM_URL = process.env.FREE_IMAGE_UPSTREAM_URL || FREE_UPSTREAM_URL;
const FREE_IMAGE_UPSTREAM_KEY = process.env.FREE_IMAGE_UPSTREAM_KEY || FREE_UPSTREAM_KEY;
const FREE_IMAGE_MODEL = process.env.FREE_IMAGE_MODEL || FREE_MODEL;
const FREE_VIDEO_MODEL = process.env.FREE_VIDEO_MODEL || FREE_IMAGE_MODEL;
const RAVENHASH_MODEL = process.env.RAVENHASH_MODEL || 'ravenhash-model';
const RAVENHASH_IMAGE_MODEL = process.env.RAVENHASH_IMAGE_MODEL || 'gpt-image-2';
const RAVENHASH_VIDEO_MODEL = process.env.RAVENHASH_VIDEO_MODEL || RAVENHASH_MODEL;
const MAX_JSON_BODY_BYTES = Number(process.env.MAX_JSON_BODY_BYTES || constants.DEFAULT_JSON_BODY_LIMIT_BYTES);
const MAX_MEDIA_UPLOAD_BYTES = Number(process.env.MAX_MEDIA_UPLOAD_BYTES || constants.MEDIA_MAX_SIZE_BYTES);
const MEDIA_TTL_HOURS = Number(process.env.MEDIA_TTL_HOURS || constants.MEDIA_EXPIRATION_HOURS);
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || './data/media');
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);
const RAVENHASH_KEY_VALIDATION_PATH = String(process.env.RAVENHASH_KEY_VALIDATION_PATH || 'models').replace(/^\/+/, '');
const RAVENHASH_KEY_VALIDATION_TIMEOUT_MS = Number(process.env.RAVENHASH_KEY_VALIDATION_TIMEOUT_MS || constants.KEY_VALIDATION_TIMEOUT_MS);
const RAVENHASH_KEY_VALIDATION_CACHE_MS = Number(process.env.RAVENHASH_KEY_VALIDATION_CACHE_MS || constants.KEY_VALIDATION_CACHE_TTL_MS);
const MEDIA_UPLOAD_RATE_LIMIT_PER_HOUR = Number(process.env.MEDIA_UPLOAD_RATE_LIMIT_PER_HOUR || constants.DEFAULT_RATE_LIMIT_PER_HOUR);
const ROUTE_HEADER = 'x-flowcanvas-model-base-url';
const allowedOrigins = new Set(
    String(process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:5180,file://,null')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
);
const keyValidationCache = new Map();
const mediaUploadAttempts = new Map();

fs.mkdirSync(MEDIA_DIR, { recursive: true });

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

function isMediaRequestPath(requestPath) {
    return requestPath === '/api/media/upload'
        || requestPath === '/v1/images/edits'
        || /^\/v1\/(?:files|uploads|videos)(?:\/|$)/.test(requestPath);
}

// Content-Length 可在读取请求体之前快速拒绝；流式 JSON 仍由 body parser 限制。
app.use((req, res, next) => {
    const contentLength = Number(req.headers['content-length'] || 0);
    const limit = isMediaRequestPath(req.path) ? MAX_MEDIA_UPLOAD_BYTES : MAX_JSON_BODY_BYTES;

    if (Number.isFinite(contentLength) && contentLength > limit) {
        return res.status(413).json({
            error: '请求体过大',
            limit: `${Math.floor(limit / 1024 / 1024)}MB`
        });
    }
    next();
});

app.use((req, res, next) => {
    const authorization = req.get('authorization');
    if (authorization && authorization.length > constants.API_KEY_MAX_LENGTH + 'Bearer '.length) {
        return res.status(400).json({ error: `API Key 超过最大长度限制 (${constants.API_KEY_MAX_LENGTH})` });
    }
    next();
});

app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && !allowedOrigins.has('*') && !allowedOrigins.has(origin)) {
        return res.status(403).json({ error: '请求来源不被允许' });
    }
    next();
});
app.use(cors({
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.has('*') || allowedOrigins.has(origin)),
    credentials: false,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-FlowCanvas-Model-Base-URL']
}));
app.use(express.json({ limit: MAX_JSON_BODY_BYTES }));

const MEDIA_EXTENSIONS = new Map([
    ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'],
    ['image/gif', '.gif'], ['image/avif', '.avif'], ['video/mp4', '.mp4'],
    ['video/webm', '.webm'], ['video/quicktime', '.mov'], ['video/x-msvideo', '.avi']
]);
const mediaUpload = multer({
    storage: multer.diskStorage({
        destination: MEDIA_DIR,
        filename: (_, file, callback) => callback(null, `${crypto.randomUUID()}${MEDIA_EXTENSIONS.get(file.mimetype) || ''}`)
    }),
    limits: { fileSize: MAX_MEDIA_UPLOAD_BYTES, files: 1 },
    fileFilter: (_, file, callback) => callback(null, MEDIA_EXTENSIONS.has(file.mimetype))
});

function nowIso() {
    return new Date().toISOString();
}

function requestedRavenhashBaseUrl(req) {
    return matchRavenhashBaseUrl(req.get(ROUTE_HEADER));
}

function requestedApiKey(req) {
    const authorization = req.get('authorization');
    if (!authorization || typeof authorization !== 'string') return '';
    if (!authorization.startsWith('Bearer ')) return '';
    const key = authorization.slice(7).trim();
    if (key.length > constants.API_KEY_MAX_LENGTH) {
        throw new Error(`API Key 超过最大长度限制 (${constants.API_KEY_MAX_LENGTH})`);
    }
    return key;
}

function upstreamForRequest(req, kind) {
    const ravenhashBaseUrl = requestedRavenhashBaseUrl(req);
    if (ravenhashBaseUrl) {
        const model = kind === 'image'
            ? RAVENHASH_IMAGE_MODEL
            : kind === 'video' ? RAVENHASH_VIDEO_MODEL : RAVENHASH_MODEL;
        return { tier: 'ravenhash', baseUrl: ravenhashBaseUrl, key: requestedApiKey(req), model };
    }

    if (kind === 'chat') {
        return { tier: 'free', baseUrl: FREE_UPSTREAM_URL, key: FREE_UPSTREAM_KEY, model: FREE_MODEL };
    }
    return {
        tier: 'free',
        baseUrl: FREE_IMAGE_UPSTREAM_URL,
        key: FREE_IMAGE_UPSTREAM_KEY,
        model: kind === 'video' ? FREE_VIDEO_MODEL : FREE_IMAGE_MODEL
    };
}

function requireConfiguredUpstream(res, upstream, serviceName) {
    if (upstream.tier === 'ravenhash' && !upstream.key) {
        res.status(401).json({ error: '请配置 RavenHash API Key' });
        return false;
    }
    if (upstream.baseUrl && upstream.key) return true;
    res.status(503).json({ error: `${upstream.tier === 'ravenhash' ? 'RavenHash' : '免费'}${serviceName}服务尚未配置` });
    return false;
}

function requireRavenhashRoute(req, res, next) {
    if (!requestedRavenhashBaseUrl(req)) {
        return res.status(403).json({ error: '素材 URL 上传仅对白名单中的 RavenHash Base URL 开放' });
    }
    if (!requestedApiKey(req)) return res.status(401).json({ error: '请配置 RavenHash API Key' });
    next();
}

function rateLimitMediaUpload(req, res, next) {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const current = mediaUploadAttempts.get(key);
    const entry = !current || current.resetAt <= now
        ? { count: 0, resetAt: now + 60 * 60 * 1000 }
        : current;
    if (entry.count >= MEDIA_UPLOAD_RATE_LIMIT_PER_HOUR) {
        return res.status(429).json({ error: '素材上传过于频繁，请稍后再试' });
    }
    entry.count += 1;
    mediaUploadAttempts.set(key, entry);
    next();
}

async function validateRavenhashKey(req, res, next) {
    const baseUrl = requestedRavenhashBaseUrl(req);
    const apiKey = requestedApiKey(req);
    const cacheKey = crypto.createHash('sha256').update(`${baseUrl}\0${apiKey}`).digest('hex');
    const cachedUntil = keyValidationCache.get(cacheKey) || 0;
    if (cachedUntil > Date.now()) return next();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RAVENHASH_KEY_VALIDATION_TIMEOUT_MS);
    try {
        const response = await fetch(endpointUrl(baseUrl, RAVENHASH_KEY_VALIDATION_PATH), {
            method: 'GET',
            headers: { authorization: `Bearer ${apiKey}` },
            signal: controller.signal
        });
        if (!response.ok) {
            const status = [401, 403].includes(response.status) ? 401 : 502;
            return res.status(status).json({ error: status === 401 ? 'RavenHash API Key 无效' : '无法验证 RavenHash API Key' });
        }
        keyValidationCache.set(cacheKey, Date.now() + RAVENHASH_KEY_VALIDATION_CACHE_MS);
        return next();
    } catch (error) {
        return res.status(502).json({ error: error.name === 'AbortError' ? 'RavenHash API Key 验证超时' : '无法验证 RavenHash API Key' });
    } finally {
        clearTimeout(timeout);
    }
}

async function cleanupExpiredMedia() {
    const now = Date.now();
    const cutoff = now - MEDIA_TTL_HOURS * 60 * 60 * 1000;

    try {
        const files = await fs.promises.readdir(MEDIA_DIR);
        for (const name of files) {
            const filePath = path.join(MEDIA_DIR, name);
            try {
                const stat = await fs.promises.stat(filePath);
                if (stat.mtimeMs < cutoff) {
                    await fs.promises.unlink(filePath);
                }
            } catch (_) { /* 文件可能已由并发清理删除 */ }
        }
    } catch (err) {
        logger.error('清理过期媒体文件失败', { error: err.message });
    }

    // 清理过期缓存
    for (const [key, expiresAt] of keyValidationCache) {
        if (expiresAt <= now) keyValidationCache.delete(key);
    }
    for (const [key, entry] of mediaUploadAttempts) {
        if (entry.resetAt <= now) mediaUploadAttempts.delete(key);
    }
}

function mediaSizeAllowed(req, res) {
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength <= MAX_MEDIA_UPLOAD_BYTES) return true;
    res.status(413).json({ error: `上传素材超过大小限制（最大 ${Math.floor(MAX_MEDIA_UPLOAD_BYTES / 1024 / 1024)}MB）` });
    return false;
}

function endpointUrl(baseUrl, pathname) {
    return `${String(baseUrl).replace(/\/+$/, '')}/${String(pathname).replace(/^\/+/, '')}`;
}

function chatUrl(baseUrl) {
    const clean = String(baseUrl || '').replace(/\/+$/, '');
    return clean.endsWith('/chat/completions') ? clean : `${clean}/chat/completions`;
}

function sendUpstreamError(res, response, apiKey = '') {
    return response.text().then(errorText => {
        const detail = apiKey ? errorText.split(apiKey).join('[redacted]') : errorText;
        res.status(response.status >= 500 ? 502 : response.status)
            .json({ error: '上游 AI 服务请求失败', detail: detail.slice(0, 500) });
    });
}

function upstreamConnectionError(error, serviceName = 'AI') {
    if (error.name === 'AbortError') return `${serviceName}服务响应超时`;
    const code = error.code || error.cause?.code;
    if (code === 'ENOTFOUND') return `无法解析${serviceName}服务域名`;
    if (code === 'ECONNREFUSED') return `${serviceName}服务拒绝连接`;
    if (code === 'ECONNRESET') return `${serviceName}服务连接已中断`;
    return `无法连接${serviceName}服务`;
}

function copyUpstreamHeaders(response, res) {
    response.headers.forEach((value, key) => {
        if (['content-type', 'cache-control', 'connection'].includes(key)) res.setHeader(key, value);
    });
}

function pipeUpstreamResponse(response, res) {
    copyUpstreamHeaders(response, res);
    if (response.body) {
        Readable.fromWeb(response.body).pipe(res);
    } else {
        res.end();
    }
}

async function proxyRawRequest(req, res, upstream, pathname, signal) {
    const headers = { authorization: `Bearer ${upstream.key}` };
    const contentType = req.headers['content-type'] || '';
    if (contentType) headers['content-type'] = contentType;
    if (req.headers.accept) headers.accept = req.headers.accept;

    const isJson = contentType.includes('application/json');
    const jsonBody = isJson ? { ...req.body } : null;
    if (jsonBody) {
        if (req.method === 'POST') jsonBody.model = upstream.model;
        delete jsonBody.base_url;
        delete jsonBody.baseUrl;
        delete jsonBody.endpoint;
        delete jsonBody.upstream;
    }

    const fetchOptions = { method: req.method, headers, signal };
    if (!['GET', 'HEAD'].includes(req.method)) {
        fetchOptions.body = isJson ? JSON.stringify(jsonBody) : Readable.toWeb(req);
        if (!isJson) fetchOptions.duplex = 'half';
    }

    const response = await fetch(endpointUrl(upstream.baseUrl, pathname), fetchOptions);
    if (!response.ok) return sendUpstreamError(res, response, upstream.key);
    return pipeUpstreamResponse(response, res);
}

async function proxyWithTimeout(req, res, upstream, pathname) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
        await proxyRawRequest(req, res, upstream, pathname, controller.signal);
    } catch (error) {
        if (!res.headersSent) {
            res.status(502).json({ error: upstreamConnectionError(error) });
        }
    } finally {
        clearTimeout(timeout);
    }
}

app.get('/health', (_, res) => {
    res.json({ ok: true, service: 'flowcanvas-gateway', time: nowIso() });
});

app.post('/api/media/upload', requireRavenhashRoute, rateLimitMediaUpload, validateRavenhashKey, (req, res) => {
    mediaUpload.single('file')(req, res, error => {
        if (error) {
            const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
            const message = error.code === 'LIMIT_FILE_SIZE'
                ? `文件超过大小限制（最大 ${Math.floor(MAX_MEDIA_UPLOAD_BYTES / 1024 / 1024)}MB）`
                : error.code === 'LIMIT_UNEXPECTED_FILE'
                ? '仅支持图片和视频文件（.jpg、.png、.webp、.gif、.mp4、.webm）'
                : `上传失败：${error.message}`;
            return res.status(status).json({ error: message });
        }
        if (!req.file) return res.status(400).json({ error: '仅支持常见图片和视频文件' });

        const publicBaseUrl = String(process.env.PUBLIC_MEDIA_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
        const expiresAt = new Date(Date.now() + MEDIA_TTL_HOURS * 60 * 60 * 1000).toISOString();
        return res.status(201).json({
            id: path.parse(req.file.filename).name,
            url: `${publicBaseUrl}/media/${encodeURIComponent(req.file.filename)}`,
            mimeType: req.file.mimetype,
            size: req.file.size,
            expiresAt
        });
    });
});

app.get('/media/:filename', (req, res) => {
    if (!/^[0-9a-f-]{36}\.(?:jpg|png|webp|gif|avif|mp4|webm|mov|avi)$/.test(req.params.filename)) {
        return res.status(404).end();
    }
    const filePath = path.join(MEDIA_DIR, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.sendFile(filePath);
});

app.post('/v1/chat/completions', async (req, res) => {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (messages.length === 0) return res.status(400).json({ error: 'messages 不能为空' });

    const upstream = upstreamForRequest(req, 'chat');
    if (!requireConfiguredUpstream(res, upstream, ' AI ')) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
        const response = await fetch(chatUrl(upstream.baseUrl), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${upstream.key}`
            },
            body: JSON.stringify({
                model: upstream.model,
                messages,
                stream: Boolean(req.body?.stream)
            }),
            signal: controller.signal
        });
        if (!response.ok) return sendUpstreamError(res, response, upstream.key);
        return pipeUpstreamResponse(response, res);
    } catch (error) {
        if (!res.headersSent) {
            return res.status(502).json({ error: upstreamConnectionError(error) });
        }
    } finally {
        clearTimeout(timeout);
    }
});

app.post('/v1/images/generations', async (req, res) => {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'prompt 不能为空' });

    const upstream = upstreamForRequest(req, 'image');
    if (!requireConfiguredUpstream(res, upstream, '图片')) return;

    const allowedBody = {
        model: upstream.model,
        prompt,
        ...(Number.isInteger(req.body?.n) ? { n: req.body.n } : {}),
        ...(typeof req.body?.size === 'string' ? { size: req.body.size } : {}),
        ...(typeof req.body?.quality === 'string' ? { quality: req.body.quality } : {}),
        ...(typeof req.body?.background === 'string' ? { background: req.body.background } : {}),
        ...(typeof req.body?.output_format === 'string' ? { output_format: req.body.output_format } : {}),
        ...(typeof req.body?.response_format === 'string' ? { response_format: req.body.response_format } : {})
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
        const response = await fetch(endpointUrl(upstream.baseUrl, 'images/generations'), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${upstream.key}`
            },
            body: JSON.stringify(allowedBody),
            signal: controller.signal
        });
        if (!response.ok) return sendUpstreamError(res, response, upstream.key);
        return pipeUpstreamResponse(response, res);
    } catch (error) {
        if (!res.headersSent) {
            return res.status(502).json({ error: upstreamConnectionError(error, '图片') });
        }
    } finally {
        clearTimeout(timeout);
    }
});

app.post('/v1/images/edits', async (req, res) => {
    if (!mediaSizeAllowed(req, res)) return;
    const upstream = upstreamForRequest(req, 'image');
    if (!requireConfiguredUpstream(res, upstream, '图片')) return;
    await proxyWithTimeout(req, res, upstream, 'images/edits');
});

app.all(/^\/v1\/(?:files(?:\/[A-Za-z0-9._-]+(?:\/content)?)?|uploads(?:\/[A-Za-z0-9._-]+(?:\/(?:parts|complete|cancel))?)?)$/, async (req, res) => {
    if (!mediaSizeAllowed(req, res)) return;
    const upstream = upstreamForRequest(req, 'image');
    if (!requireConfiguredUpstream(res, upstream, '素材')) return;
    await proxyWithTimeout(req, res, upstream, req.path.slice('/v1/'.length));
});

app.all(/^\/v1\/videos(?:\/[A-Za-z0-9._-]+(?:\/(?:content|remix))?)?$/, async (req, res) => {
    if (!mediaSizeAllowed(req, res)) return;
    const upstream = upstreamForRequest(req, 'video');
    if (!requireConfiguredUpstream(res, upstream, '视频')) return;
    await proxyWithTimeout(req, res, upstream, req.path.slice('/v1/'.length));
});

app.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large') {
        return res.status(413).json({
            error: '请求体过大',
            limit: `${Math.floor(MAX_JSON_BODY_BYTES / 1024 / 1024)}MB`
        });
    }
    return next(error);
});

function startServer() {
    validateEnv();
    cleanupExpiredMedia();
    const mediaCleanupTimer = setInterval(cleanupExpiredMedia, 60 * 60 * 1000);
    mediaCleanupTimer.unref();
    return app.listen(PORT, () => logger.info('Gateway 启动成功', { port: PORT, host: 'localhost' }));
}

if (require.main === module) {
    try {
        startServer();
    } catch (error) {
        logger.error('Gateway 启动失败', { error: error.message });
        process.exitCode = 1;
    }
}

module.exports = {
    app,
    startServer,
    validateEnv,
    upstreamForRequest,
    requestedRavenhashBaseUrl,
    requestedApiKey
};
