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
    return getGeneratedImageDataList(payload)[0] || null;
}

function getGeneratedImageDataList(payload = {}) {
    const collections = [
        payload?.data,
        payload?.result?.data,
        payload?.output?.data,
        payload?.result?.output?.data,
        payload?.images,
        payload?.result?.images
    ];
    const collection = collections.find(value => Array.isArray(value) && value.length);
    if (collection) {
        return collection.map(value => {
            if (value && typeof value === 'object') return value;
            return typeof value === 'string' && value.trim() ? { url: value.trim() } : null;
        }).filter(Boolean);
    }

    const source = payload?.imageUrl
        || payload?.image_url
        || payload?.result?.imageUrl
        || payload?.result?.image_url;
    return typeof source === 'string' && source.trim() ? [{ url: source.trim() }] : [];
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

function hasMidjourneyParameter(prompt, names) {
    const alternatives = names.map(name => String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    return new RegExp(`(?:^|\\s)--(?:${alternatives})(?:\\s|=|$)`, 'i').test(String(prompt || ''));
}

function clampedNumber(value, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : null;
}

function midjourneyArgument(value, maxTokens = 16) {
    return String(value || '')
        .trim()
        .split(/\s+/)
        .filter(token => token && !token.startsWith('--'))
        .slice(0, maxTokens)
        .join(' ');
}

function appendMidjourneyParameters(prompt, options = {}, size = '') {
    let value = String(prompt || '').trim();
    const parameters = [];
    const append = (names, parameter) => {
        if (parameter && !hasMidjourneyParameter(value, names)) parameters.push(parameter);
    };

    const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.test(String(options.ratio || '').trim())
        ? String(options.ratio).trim()
        : midjourneyAspectRatio(size);
    append(['ar', 'aspect'], ratio ? `--ar ${ratio}` : '');

    const styleReference = midjourneyArgument(options.styleReference);
    const omniReference = midjourneyArgument(options.omniReference, 1);
    const requestedVersion = String(options.version || '').trim().toLowerCase().replace(/^v/, '');
    const version = omniReference ? '7' : requestedVersion;
    if (/^niji(?:[-\s]?7)?$/.test(version)) {
        append(['niji', 'v', 'version'], '--niji 7');
    } else if (['8.2', '8.1', '7', '6.1', '6'].includes(version)) {
        append(['niji', 'v', 'version'], `--v ${version}`);
    }

    if (options.raw === true) append(['raw'], '--raw');

    const stylize = clampedNumber(options.stylize, 0, 1000);
    if (stylize != null && stylize !== 100) append(['s', 'stylize'], `--s ${Math.round(stylize)}`);
    const chaos = clampedNumber(options.chaos, 0, 100);
    if (chaos != null && chaos !== 0) append(['c', 'chaos'], `--c ${Math.round(chaos)}`);
    const weird = clampedNumber(options.weird, 0, 3000);
    if (weird != null && weird !== 0) append(['w', 'weird'], `--w ${Math.round(weird)}`);

    const draft = options.draft === true && version === '7' && !omniReference;
    const quality = Number(options.quality);
    if (!draft && !omniReference && [0.5, 1, 2, 4].includes(quality) && quality !== 1) {
        append(['q', 'quality'], `--q ${quality}`);
    }

    const imageWeightMax = /^niji/.test(version) ? 2 : 3;
    const imageWeight = clampedNumber(options.imageWeight, 0, imageWeightMax);
    if (options.hasImagePrompt === true && imageWeight != null && imageWeight !== 1) {
        append(['iw'], `--iw ${imageWeight}`);
    }

    append(['sref'], styleReference ? `--sref ${styleReference}` : '');
    const hasStyleReference = Boolean(styleReference) || hasMidjourneyParameter(value, ['sref']);
    const styleWeight = clampedNumber(options.styleWeight, 0, 1000);
    if (hasStyleReference && styleWeight != null && styleWeight !== 100) {
        append(['sw'], `--sw ${Math.round(styleWeight)}`);
    }
    const styleVersion = Math.round(clampedNumber(options.styleVersion, 1, 6) || 0);
    if (hasStyleReference && styleVersion) append(['sv'], `--sv ${styleVersion}`);

    append(['oref'], omniReference ? `--oref ${omniReference}` : '');
    const hasOmniReference = Boolean(omniReference) || hasMidjourneyParameter(value, ['oref']);
    const omniWeight = clampedNumber(options.omniWeight, 1, 1000);
    if (hasOmniReference && omniWeight != null && omniWeight !== 100) {
        append(['ow'], `--ow ${Math.round(omniWeight)}`);
    }

    const profile = midjourneyArgument(options.profile, 8);
    append(['p', 'profile'], profile ? `--p ${profile}` : '');

    const seed = clampedNumber(options.seed, 0, 4294967295);
    if (String(options.seed ?? '').trim() && seed != null) append(['seed'], `--seed ${Math.round(seed)}`);
    if (options.tile === true) append(['tile'], '--tile');
    if (draft) append(['draft'], '--draft');

    const repeat = Math.round(clampedNumber(options.repeat, 1, 4) || 1);
    if (repeat > 1) append(['r', 'repeat'], `--r ${repeat}`);

    const speed = String(options.speed || '').trim().toLowerCase();
    if (['fast', 'relax', 'turbo'].includes(speed) && !(omniReference && speed !== 'relax')) {
        append(['fast', 'relax', 'turbo'], `--${speed}`);
    }
    const visibility = String(options.visibility || '').trim().toLowerCase();
    if (['public', 'stealth'].includes(visibility)) {
        append(['public', 'stealth'], `--${visibility}`);
    }

    const definition = String(options.definition || '').trim().toLowerCase();
    const supportsDefinition = !version || ['8.2', '8.1'].includes(version);
    if (supportsDefinition && definition === 'hd') append(['hd', 'sd'], '--hd');
    if (supportsDefinition && definition === 'sd') append(['hd', 'sd'], '--sd');

    const negativePrompt = String(options.negativePrompt || '').trim();
    append(['no'], negativePrompt ? `--no ${negativePrompt}` : '');

    if (parameters.length) value = `${value} ${parameters.join(' ')}`.trim();
    return value;
}

function buildMidjourneyImaginePayload(prompt, images = [], size = '', options = {}) {
    return {
        base64Array: images.map(image => `data:${image.mimeType || 'application/octet-stream'};base64,${image.buffer.toString('base64')}`),
        notifyHook: '',
        prompt: appendMidjourneyParameters(prompt, {
            ...options,
            hasImagePrompt: options.hasImagePrompt === true || images.length > 0
        }, size),
        state: '',
        botType: 'MID_JOURNEY'
    };
}

function isMidjourneyImageModel(model) {
    const normalized = String(model || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    return normalized.includes('mjimagine') || normalized.includes('midjourney');
}

function isMidjourneyImagineModel(model) {
    const normalized = String(model || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    return normalized === 'mjimagine' || normalized === 'midjourney';
}

function midjourneyGridRegions(width, height) {
    const pixelWidth = Math.floor(Number(width));
    const pixelHeight = Math.floor(Number(height));
    if (pixelWidth < 2 || pixelHeight < 2) return [];
    const leftWidth = Math.floor(pixelWidth / 2);
    const topHeight = Math.floor(pixelHeight / 2);
    const rightWidth = pixelWidth - leftWidth;
    const bottomHeight = pixelHeight - topHeight;
    return [
        { left: 0, top: 0, width: leftWidth, height: topHeight },
        { left: leftWidth, top: 0, width: rightWidth, height: topHeight },
        { left: 0, top: topHeight, width: leftWidth, height: bottomHeight },
        { left: leftWidth, top: topHeight, width: rightWidth, height: bottomHeight }
    ];
}

function isNativeMidjourneyEndpoint(endpoint) {
    const raw = String(endpoint || '').trim();
    if (!raw) return false;
    try {
        const pathname = new URL(raw).pathname.replace(/\/+$/, '');
        return /(?:^|\/)mj(?:\/|$)/i.test(pathname);
    } catch (_) {
        return /(?:^|\/)mj(?:\/|$)/i.test(raw);
    }
}

function shouldUseNativeMidjourneyRoute(model, endpoint) {
    return isMidjourneyImageModel(model) && isNativeMidjourneyEndpoint(endpoint);
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
    appendMidjourneyParameters,
    buildImageEditMultipart,
    buildImageTaskEndpoint,
    buildMidjourneyImaginePayload,
    buildMidjourneySubmitEndpoint,
    buildMidjourneyTaskEndpoint,
    collectImageEditInputs,
    getGeneratedImageData,
    getGeneratedImageDataList,
    getImageTaskId,
    getImageTaskIdFromLocation,
    imageHttpErrorMessage,
    imageTaskErrorMessage,
    imageTaskRetryDelayMs,
    imageTaskStatus,
    isCompletedImageTaskStatus,
    isFailedImageTaskStatus,
    isImageTaskPayload,
    isMidjourneyImagineModel,
    isMidjourneyImageModel,
    isNativeMidjourneyEndpoint,
    midjourneyGridRegions,
    shouldUseNativeMidjourneyRoute
};
