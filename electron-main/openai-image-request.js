const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function imageMimeType(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === '.png') return 'image/png';
    if (extension === '.webp') return 'image/webp';
    return 'image/jpeg';
}

function collectImageEditInputs(sourceReferences = []) {
    return sourceReferences.map(reference => {
        const filePath = String(reference?.filePath || '').trim();
        const stats = fs.statSync(filePath);
        if (stats.size > 50 * 1024 * 1024) {
            throw new Error(`Image reference is larger than 50 MB: ${path.basename(filePath)}`);
        }
        return {
            fileName: path.basename(filePath),
            mimeType: imageMimeType(filePath),
            buffer: fs.readFileSync(filePath)
        };
    });
}

function safeDispositionValue(value) {
    return String(value || '').replace(/[\r\n"]/g, '_');
}

function buildImageEditMultipart(fields = {}, images = []) {
    const boundary = `----flow-canvas-${crypto.randomBytes(16).toString('hex')}`;
    const chunks = [];
    const appendText = value => chunks.push(Buffer.from(String(value), 'utf8'));
    const appendLine = (value = '') => appendText(`${value}\r\n`);

    Object.entries(fields).forEach(([name, value]) => {
        if (value === undefined || value === null) return;
        appendLine(`--${boundary}`);
        appendLine(`Content-Disposition: form-data; name="${safeDispositionValue(name)}"`);
        appendLine();
        appendLine(value);
    });

    const imageField = images.length === 1 ? 'image' : 'image[]';
    images.forEach(image => {
        appendLine(`--${boundary}`);
        appendLine(`Content-Disposition: form-data; name="${imageField}"; filename="${safeDispositionValue(image.fileName)}"`);
        appendLine(`Content-Type: ${image.mimeType || 'application/octet-stream'}`);
        appendLine();
        chunks.push(image.buffer);
        appendLine();
    });
    appendLine(`--${boundary}--`);

    return {
        body: Buffer.concat(chunks),
        contentType: `multipart/form-data; boundary=${boundary}`
    };
}

const IMAGE_TASK_PENDING_STATUSES = new Set([
    'queued', 'submitted', 'pending', 'waiting', 'in_progress', 'running', 'processing'
]);
const IMAGE_TASK_COMPLETED_STATUSES = new Set(['completed', 'success', 'succeeded']);
const IMAGE_TASK_FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected']);

function imageTaskStatus(payload = {}) {
    return String(payload?.status || payload?.data?.status || '').trim().toLowerCase();
}

function normalizeImageTaskId(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value !== 'string') return '';
    const normalized = value.trim();
    if (!normalized || normalized.length > 256 || /^(?:https?:|data:)/i.test(normalized)) return '';
    return normalized;
}

function getImageTaskIdFromLocation(location = '') {
    const value = String(location || '').trim();
    if (!value) return '';
    try {
        const url = new URL(value, 'https://flow-canvas.invalid');
        const segments = url.pathname.split('/').filter(Boolean);
        const fetchIndex = segments.lastIndexOf('fetch');
        const candidate = fetchIndex > 0 ? segments[fetchIndex - 1] : segments.at(-1);
        return normalizeImageTaskId(decodeURIComponent(candidate || ''));
    } catch (_) {
        return '';
    }
}

function taskIdFromEmbeddedError(error) {
    if (!error) return '';
    if (typeof error === 'object') {
        const explicit = error.task_id || error.taskId || error.id
            || error.data?.task_id || error.data?.taskId || error.data?.id
            || error.details?.task_id || error.details?.taskId || error.details?.id;
        const explicitId = normalizeImageTaskId(explicit);
        if (explicitId) return explicitId;
        return taskIdFromEmbeddedError(error.message)
            || taskIdFromEmbeddedError(error.body)
            || taskIdFromEmbeddedError(error.details);
    }
    if (typeof error !== 'string') return '';
    const text = error.trim();
    if (!text) return '';
    try {
        const parsed = JSON.parse(text);
        const parsedId = getImageTaskId(parsed, 202);
        if (parsedId) return parsedId;
    } catch (_) {
        // Some relays embed the upstream JSON inside a plain-text error message.
    }
    const labelled = text.match(/(?:task(?:_|\s*)id|"id")\s*[=:]\s*["']?([A-Za-z0-9][A-Za-z0-9._:-]{5,255})/i);
    return normalizeImageTaskId(labelled?.[1]);
}

function getImageTaskId(payload = {}, statusCode = 0, location = '') {
    const explicit = payload?.task_id
        || payload?.taskId
        || payload?.data?.task_id
        || payload?.data?.taskId
        || payload?.data?.id
        || payload?.result?.task_id
        || payload?.result?.taskId
        || payload?.result?.id
        || payload?.task?.id;
    const explicitId = normalizeImageTaskId(explicit);
    if (explicitId) return explicitId;

    const embeddedErrorId = taskIdFromEmbeddedError(payload?.error);
    if (embeddedErrorId) return embeddedErrorId;

    const locationId = getImageTaskIdFromLocation(location);
    if (locationId) return locationId;

    const status = imageTaskStatus(payload);
    const objectType = String(payload?.object || '').trim().toLowerCase();
    if (payload?.id != null && (status || objectType.includes('task'))) {
        return normalizeImageTaskId(payload.id);
    }

    const acceptsScalarTaskId = Number(statusCode) === 202
        || IMAGE_TASK_PENDING_STATUSES.has(status)
        || (Number(payload?.code) === 1 && /submit|queued|accepted/i.test(String(payload?.description || '')));
    if (acceptsScalarTaskId) {
        const scalarId = normalizeImageTaskId(payload?.result) || normalizeImageTaskId(payload?.data);
        if (scalarId) return scalarId;
    }
    return '';
}

function isImageTaskPayload(payload, statusCode = 0, location = '') {
    const taskId = getImageTaskId(payload, statusCode, location);
    if (!taskId) return false;
    const status = imageTaskStatus(payload);
    const objectType = String(payload?.object || '').trim().toLowerCase();
    const midjourneyCode = Number(payload?.code);
    return Number(statusCode) === 202
        || objectType.includes('image.generation.task')
        || [1, 21, 22].includes(midjourneyCode)
        || IMAGE_TASK_PENDING_STATUSES.has(status)
        || IMAGE_TASK_COMPLETED_STATUSES.has(status)
        || IMAGE_TASK_FAILED_STATUSES.has(status);
}

function getGeneratedImageData(payload = {}) {
    const candidates = [
        payload?.data?.[0],
        payload?.result?.data?.[0],
        payload?.output?.data?.[0],
        payload?.result?.output?.data?.[0]
    ];
    const image = candidates.find(value => value && typeof value === 'object');
    if (image) return image;

    const source = payload?.imageUrl
        || payload?.image_url
        || payload?.result?.imageUrl
        || payload?.result?.image_url;
    return typeof source === 'string' && source.trim() ? { url: source.trim() } : null;
}

function isCompletedImageTaskStatus(status) {
    return IMAGE_TASK_COMPLETED_STATUSES.has(String(status || '').trim().toLowerCase());
}

function isFailedImageTaskStatus(status) {
    return IMAGE_TASK_FAILED_STATUSES.has(String(status || '').trim().toLowerCase());
}

function imageTaskErrorMessage(payload = {}) {
    const error = payload?.error || payload?.result?.error;
    if (typeof error === 'string' && error.trim()) return error.trim();
    return String(
        error?.message
        || payload?.failReason
        || payload?.result?.failReason
        || payload?.message
        || payload?.description
        || ''
    ).trim();
}

function imageHttpErrorMessage(statusCode, responseText = '', options = {}) {
    const text = String(responseText || '').trim();
    let payload = null;
    try {
        payload = text ? JSON.parse(text) : null;
    } catch (_) {
        payload = null;
    }
    const reason = payload ? imageTaskErrorMessage(payload) : '';
    if (options.nativeMidjourney && reason === 'unmarshal_response_body_failed') {
        return 'RavenHash 的 NewAPI 无法解析上游 Midjourney 响应。当前原生 MJ 转发使用 mj-api-secret，但该上游要求 Authorization: Bearer；需要修改 RavenHash 服务端的上游鉴权头。';
    }
    if (options.nativeMidjourney && reason) {
        return `Midjourney 提交失败（HTTP ${statusCode}）：${reason}`;
    }
    return `Image API failed: ${statusCode}${text ? ` ${text.slice(0, 2000)}` : ''}`;
}

function buildImageTaskEndpoint(generationEndpoint, taskId, location = '') {
    const base = new URL(generationEndpoint);
    const locationValue = String(location || '').trim();
    if (locationValue) {
        const located = new URL(locationValue, base);
        if (located.origin === base.origin) {
            located.hash = '';
            return located.toString();
        }
    }

    let pathname = base.pathname.replace(/\/+$/, '');
    if (/\/images\/(?:generations|edits)$/i.test(pathname)) {
        pathname = pathname.replace(/\/images\/(?:generations|edits)$/i, '/images/generations');
    } else if (/\/edits$/i.test(pathname)) {
        pathname = pathname.replace(/\/edits$/i, '/images/generations');
    }
    base.pathname = `${pathname}/${encodeURIComponent(String(taskId))}`;
    base.search = '';
    base.hash = '';
    return base.toString();
}

function buildMidjourneyTaskEndpoint(generationEndpoint, taskId) {
    const url = new URL(generationEndpoint);
    url.pathname = `/mj/task/${encodeURIComponent(String(taskId))}/fetch`;
    url.search = '';
    url.hash = '';
    return url.toString();
}

function buildMidjourneySubmitEndpoint(endpoint) {
    const url = new URL(endpoint);
    url.pathname = '/mj/submit/imagine';
    url.search = '';
    url.hash = '';
    return url.toString();
}

function greatestCommonDivisor(left, right) {
    let a = Math.abs(Math.trunc(left));
    let b = Math.abs(Math.trunc(right));
    while (b) [a, b] = [b, a % b];
    return a || 1;
}

function midjourneyAspectRatio(size = '') {
    const match = /^(\d+)x(\d+)$/i.exec(String(size || '').trim());
    if (!match) return '';
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return '';
    const divisor = greatestCommonDivisor(width, height);
    return `${width / divisor}:${height / divisor}`;
}

function appendMidjourneyAspectRatio(prompt, size = '') {
    const value = String(prompt || '').trim();
    if (!value || /(?:^|\s)--(?:ar|aspect)(?:\s|=)/i.test(value)) return value;
    const ratio = midjourneyAspectRatio(size);
    return ratio ? `${value} --ar ${ratio}` : value;
}

function buildMidjourneyImaginePayload(prompt, images = [], size = '') {
    return {
        base64Array: images.map(image => `data:${image.mimeType || 'application/octet-stream'};base64,${image.buffer.toString('base64')}`),
        notifyHook: '',
        prompt: appendMidjourneyAspectRatio(prompt, size),
        state: '',
        botType: 'MID_JOURNEY'
    };
}

function isMidjourneyImageModel(model) {
    const normalized = String(model || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    return normalized.includes('mjimagine') || normalized.includes('midjourney');
}

function imageTaskRetryDelayMs(value, fallbackMs = 2000, now = Date.now()) {
    const raw = String(value || '').trim();
    let delay = Number(raw) * 1000;
    if (!raw || !Number.isFinite(delay)) {
        const retryAt = Date.parse(raw);
        delay = Number.isFinite(retryAt) ? retryAt - now : fallbackMs;
    }
    if (!Number.isFinite(delay) || delay <= 0) delay = fallbackMs;
    return Math.max(500, Math.min(10000, Math.round(delay)));
}

module.exports = {
    buildImageEditMultipart,
    buildImageTaskEndpoint,
    buildMidjourneyImaginePayload,
    buildMidjourneySubmitEndpoint,
    buildMidjourneyTaskEndpoint,
    collectImageEditInputs,
    getGeneratedImageData,
    getImageTaskId,
    getImageTaskIdFromLocation,
    imageHttpErrorMessage,
    imageTaskErrorMessage,
    imageTaskRetryDelayMs,
    imageTaskStatus,
    isCompletedImageTaskStatus,
    isFailedImageTaskStatus,
    isImageTaskPayload,
    isMidjourneyImageModel
};
