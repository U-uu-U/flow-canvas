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

function isGptImage2Model(model) {
    const normalized = String(model || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    return normalized === 'gptimage2';
}

function buildOpenAiImageRequestBody({ model, prompt, size, n = 1, responseFormat = 'b64_json', options = {} } = {}) {
    const stream = options.stream === true;
    const body = {
        model,
        prompt,
        n: Math.min(8, Math.max(1, Number(n) || 1)),
        quality: ['auto', 'low', 'medium', 'high'].includes(String(options.quality || '').toLowerCase())
            ? String(options.quality).toLowerCase()
            : 'high',
        response_format: responseFormat === 'b64_json' ? 'b64_json' : 'url',
        history_disabled: options.historyDisabled !== false,
        stream
    };
    if (size) body.size = size;
    return body;
}

function parseImageApiResponseText(responseText = '', contentType = '') {
    const text = String(responseText || '').trim();
    if (!text) return null;

    try {
        return JSON.parse(text);
    } catch (_) {
        // Streamed image responses are usually Server-Sent Events rather than one JSON document.
    }

    const events = [];
    let dataLines = [];
    const flushEvent = () => {
        const data = dataLines.join('\n').trim();
        dataLines = [];
        if (!data || data === '[DONE]') return;
        try {
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed === 'object') events.push(parsed);
            return;
        } catch (_) {
            // Some relays send the final image source as plain SSE data.
        }
        if (/^(?:https?:|data:image\/)/i.test(data)) {
            events.push({ data: [{ url: data }] });
        } else if (data.length > 512 && /^[A-Za-z0-9+/=\s]+$/.test(data)) {
            events.push({ data: [{ b64_json: data }] });
        }
    };
    text.replace(/\r\n?/g, '\n').split('\n').forEach(line => {
        if (!line.trim()) {
            flushEvent();
            return;
        }
        const match = line.match(/^\s*data\s*:\s?(.*)$/i);
        if (match) dataLines.push(match[1]);
    });
    flushEvent();
    if (events.length === 1) return events[0];
    if (events.length > 1) {
        const aggregate = {};
        events.forEach(event => {
            Object.entries(event).forEach(([key, value]) => {
                if (['data', 'output', 'images', 'results', 'content'].includes(key)) {
                    const previous = Array.isArray(aggregate[key]) ? aggregate[key] : [];
                    aggregate[key] = previous.concat(Array.isArray(value) ? value : [value]);
                } else if (value !== undefined) {
                    aggregate[key] = value;
                }
            });
        });
        aggregate.output = events;
        return aggregate;
    }

    if (/event-stream/i.test(String(contentType))) return null;
    return null;
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
    return String(
        payload?.status
        || payload?.data?.status
        || payload?.result?.status
        || payload?.output?.status
        || payload?.response?.status
        || payload?.task?.status
        || ''
    ).trim().toLowerCase();
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
        || payload?.data?.output?.task_id
        || payload?.data?.output?.taskId
        || payload?.data?.output?.id
        || payload?.result?.task_id
        || payload?.result?.taskId
        || payload?.result?.id
        || payload?.result?.output?.task_id
        || payload?.result?.output?.taskId
        || payload?.result?.output?.id
        || payload?.output?.task_id
        || payload?.output?.taskId
        || payload?.output?.id
        || payload?.response?.task_id
        || payload?.response?.taskId
        || payload?.response?.id
        || payload?.task?.id;
    const explicitId = normalizeImageTaskId(explicit);
    if (explicitId) return explicitId;

    const embeddedErrorId = taskIdFromEmbeddedError(payload?.error);
    if (embeddedErrorId) return embeddedErrorId;

    const locationId = getImageTaskIdFromLocation(location);
    if (locationId) return locationId;

    const status = imageTaskStatus(payload);
    const objectTypes = [
        payload?.object,
        payload?.data?.object,
        payload?.result?.object,
        payload?.output?.object,
        payload?.response?.object
    ].map(value => String(value || '').trim().toLowerCase());
    const looksLikeImageTask = objectTypes.some(value =>
        /(?:image|generation).*(?:task|job|generation)|(?:task|job|generation).*(?:image|generation)/i.test(value)
    );
    if (payload?.id != null && (status || looksLikeImageTask)) {
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
    const objectTypes = [
        payload?.object,
        payload?.data?.object,
        payload?.result?.object,
        payload?.output?.object,
        payload?.response?.object
    ].map(value => String(value || '').trim().toLowerCase());
    const midjourneyCode = Number(payload?.code);
    const looksLikeImageTask = objectTypes.some(value =>
        /(?:image|generation).*(?:task|job|generation)|(?:task|job|generation).*(?:image|generation)/i.test(value)
    );
    const hasImage = Boolean(getGeneratedImageData(payload));
    return Number(statusCode) === 202
        || looksLikeImageTask
        || [1, 21, 22].includes(midjourneyCode)
        || IMAGE_TASK_PENDING_STATUSES.has(status)
        || IMAGE_TASK_COMPLETED_STATUSES.has(status)
        || IMAGE_TASK_FAILED_STATUSES.has(status)
        || (!hasImage && Boolean(status || payload?.id) && objectTypes.some(value => /image|generation/i.test(value)));
}

function getGeneratedImageData(payload = {}) {
    return getGeneratedImageDataList(payload)[0] || null;
}

const IMAGE_SOURCE_KEYS = [
    'url', 'image_url', 'imageUrl', 'output_url', 'outputUrl',
    'video_url', 'videoUrl',
    'signed_url', 'signedUrl', 'src', 'b64_json', 'base64',
    'base64_image', 'image_base64', 'base64Data'
];
const IMAGE_CONTAINER_KEYS = [
    'data', 'images', 'image', 'output', 'outputs', 'result', 'results',
    'content', 'artifacts', 'choices', 'message', 'response', 'body', 'payload'
];

const GENERATED_VIDEO_EXTENSIONS = new Set([
    '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wmv', '.flv', '.mpeg', '.mpg'
]);

function generatedSourceExtension(source = '') {
    const value = String(source || '').trim();
    if (!value || /^data:/i.test(value)) return '';
    try {
        return path.extname(new URL(value, 'https://flow-canvas.invalid').pathname).toLowerCase();
    } catch (_) {
        return path.extname(value.split(/[?#]/, 1)[0]).toLowerCase();
    }
}

function generatedVideoExtensionFromBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return '';
    if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
        return buffer.subarray(8, 12).toString('ascii').trim().toLowerCase() === 'qt' ? '.mov' : '.mp4';
    }
    if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return '.webm';
    if (buffer.length >= 12
        && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'AVI ') {
        return '.avi';
    }
    return '';
}

function describeGeneratedMedia(buffer, metadata = {}, hints = {}) {
    const signatureExtension = generatedVideoExtensionFromBuffer(buffer);
    if (signatureExtension) return { mediaType: 'video', extension: signatureExtension };

    const format = String(metadata?.format || '').trim().toLowerCase();
    if (format) {
        const extension = format === 'jpeg' ? '.jpg' : format === 'webp' ? '.webp' : '.png';
        return { mediaType: 'image', extension };
    }

    const contentType = String(hints?.contentType || '').trim().toLowerCase();
    const sourceExtension = generatedSourceExtension(hints?.source);
    if (contentType.startsWith('video/') || GENERATED_VIDEO_EXTENSIONS.has(sourceExtension)) {
        const extension = GENERATED_VIDEO_EXTENSIONS.has(sourceExtension)
            ? sourceExtension
            : contentType.includes('webm')
                ? '.webm'
                : contentType.includes('quicktime')
                    ? '.mov'
                    : '.mp4';
        return { mediaType: 'video', extension };
    }

    return { mediaType: 'image', extension: '.png' };
}

function imageSourceString(value) {
    if (typeof value !== 'string') return '';
    const source = value.trim();
    if (!source) return '';
    if (/^(?:https?:|data:image\/)/i.test(source)) return source;
    if (source.length > 512 && /^[A-Za-z0-9+/=\s]+$/.test(source)) return source;
    return '';
}

function normalizeImageEntry(value) {
    if (typeof value === 'string') {
        const source = imageSourceString(value);
        return source ? { url: source } : null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    for (const key of IMAGE_SOURCE_KEYS) {
        const candidate = value[key];
        if (typeof candidate === 'string') {
            const source = key.includes('base64') || key === 'b64_json'
                ? candidate.trim()
                : candidate.trim();
            if (!source) continue;
            if (key.includes('base64') || key === 'b64_json') {
                return { ...value, b64_json: source };
            }
            return { ...value, url: source };
        }
        if (candidate && typeof candidate === 'object') {
            const nested = normalizeImageEntry(candidate);
            if (nested) return { ...value, ...nested };
        }
    }

    // Responses-style image generation calls put the Base64 result in `result`.
    const resultSource = imageSourceString(value.result);
    if (resultSource) return { ...value, b64_json: resultSource };
    return null;
}

function imageEntryIdentity(entry) {
    return String(entry?.url || entry?.b64_json || '').trim();
}

function getGeneratedImageDataList(payload = {}) {
    const results = [];
    const seenObjects = new Set();
    const seenSources = new Set();
    const add = entry => {
        if (!entry) return;
        const identity = imageEntryIdentity(entry);
        if (identity && seenSources.has(identity)) return;
        if (identity) seenSources.add(identity);
        results.push(entry);
    };
    const visit = (value, depth = 0, allowPlainString = false) => {
        if (value == null || depth > 8) return;
        if (typeof value === 'string') {
            const source = value.trim();
            if (/^[\[{]/.test(source)) {
                try {
                    visit(JSON.parse(source), depth + 1, allowPlainString);
                    return;
                } catch (_) {
                    // Continue with normal URL/Base64 handling for non-JSON strings.
                }
            }
            add(normalizeImageEntry(value) || (allowPlainString && source ? { url: source } : null));
            return;
        }
        if (typeof value !== 'object') return;
        if (seenObjects.has(value)) return;
        seenObjects.add(value);

        const direct = normalizeImageEntry(value);
        if (direct) {
            add(direct);
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(item => visit(item, depth + 1, allowPlainString));
            return;
        }
        IMAGE_CONTAINER_KEYS.forEach(key => {
            if (value[key] !== undefined) {
                const acceptsPlainString = ['data', 'images', 'image', 'output', 'outputs', 'artifacts'].includes(key);
                visit(value[key], depth + 1, acceptsPlainString);
            }
        });
    };

    visit(payload);
    return results;
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
    const errorCode = String(payload?.error?.code || payload?.code || '').trim().toLowerCase();
    const errorType = String(payload?.error?.type || payload?.type || '').trim().toLowerCase();
    if (errorCode === 'all_vendors_failed' || (Number(statusCode) === 503 && errorType === 'yamlrunner_error')) {
        if (options.midjourneyModel && options.compatibilityFallbackUsed) {
            return `Midjourney 上游提交失败（HTTP ${statusCode}）。Flow Canvas 已先后尝试完整参数和仅保留提示词、画幅比例的兼容参数，但 RavenHash/上游 MJ 通道均未创建任务；请检查中转站的 MJ 渠道或账号池状态。`;
        }
        const retries = Math.max(0, Number(options.attempts || 1) - 1);
        const retryText = retries > 0 ? `，已自动重试 ${retries} 次` : '';
        const subject = options.midjourneyModel ? 'Midjourney' : '图片';
        return `${subject}上游通道暂时全部不可用（HTTP ${statusCode}${retryText}）。请求已到达 RavenHash，但所有上游供应商都执行失败；请稍后重试，或在模型栏切换其他可用 API。`;
    }
    if (options.nativeMidjourney && reason === 'unmarshal_response_body_failed') {
        return 'RavenHash 的 NewAPI 无法解析上游 Midjourney 响应。当前原生 MJ 转发使用 mj-api-secret，但该上游要求 Authorization: Bearer；需要修改 RavenHash 服务端的上游鉴权头。';
    }
    if (options.nativeMidjourney && reason) {
        return `Midjourney 提交失败（HTTP ${statusCode}）：${reason}`;
    }
    return `Image API failed: ${statusCode}${text ? ` ${text.slice(0, 2000)}` : ''}`;
}

function isAllVendorsFailedImageResponse(statusCode, responseText = '') {
    if (Number(statusCode) !== 503) return false;
    const text = String(responseText || '').trim();
    if (!text) return false;
    try {
        const payload = JSON.parse(text);
        const errorCode = String(payload?.error?.code || payload?.code || '').trim().toLowerCase();
        const errorType = String(payload?.error?.type || payload?.type || '').trim().toLowerCase();
        return errorCode === 'all_vendors_failed' || errorType === 'yamlrunner_error';
    } catch (_) {
        const normalized = text.toLowerCase();
        return normalized.includes('all_vendors_failed') || normalized.includes('yamlrunner_error');
    }
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

function buildMidjourneyCompatibilityPrompt(prompt, options = {}, size = '') {
    const source = String(prompt || '').trim();
    if (!source) return '';

    const ratioMatch = source.match(/(?:^|\s)--(?:ar|aspect)(?:\s+|=)(\d+(?:\.\d+)?:\d+(?:\.\d+)?)(?=\s|$)/i);
    const optionRatio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.test(String(options.ratio || '').trim())
        ? String(options.ratio).trim()
        : '';
    const ratio = ratioMatch?.[1] || optionRatio || midjourneyAspectRatio(size);
    const parameterStart = source.search(/(?:^|\s)--(?:ar|aspect|v|version|niji|raw|s|stylize|c|chaos|w|weird|q|quality|iw|sref|sw|sv|oref|ow|p|profile|seed|tile|draft|r|repeat|fast|relax|turbo|public|stealth|hd|sd|no)(?=\s|=|$)/i);
    const plainPrompt = (parameterStart >= 0 ? source.slice(0, parameterStart) : source).trim();
    if (!plainPrompt) return source;
    return ratio ? `${plainPrompt} --ar ${ratio}` : plainPrompt;
}

function prependMidjourneyImagePrompts(prompt, imageUrls = []) {
    const urls = [];
    const seen = new Set();
    for (const value of imageUrls) {
        try {
            const url = new URL(String(value || '').trim());
            if (!['http:', 'https:'].includes(url.protocol)) continue;
            const normalized = url.toString();
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            urls.push(normalized);
        } catch (_) {
            // Midjourney image prompts require public HTTP(S) URLs.
        }
    }
    const text = String(prompt || '').trim();
    return [...urls, text].filter(Boolean).join(' ');
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

function isRetryableImageHttpStatus(statusCode) {
    return [429, 502, 503, 504].includes(Number(statusCode));
}

function isRetryableImageNetworkError(error) {
    const details = [
        error?.name,
        error?.code,
        error?.message,
        error?.cause?.name,
        error?.cause?.code,
        error?.cause?.message
    ].filter(Boolean).join(' ');
    return /AbortError|ERR_(?:CONNECTION_(?:TIMED_OUT|CLOSED|RESET|REFUSED)|TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|HTTP2_PROTOCOL_ERROR)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network error/i.test(details);
}

module.exports = {
    appendMidjourneyParameters,
    buildMidjourneyCompatibilityPrompt,
    buildImageEditMultipart,
    buildOpenAiImageRequestBody,
    buildImageTaskEndpoint,
    buildMidjourneyImaginePayload,
    buildMidjourneySubmitEndpoint,
    buildMidjourneyTaskEndpoint,
    collectImageEditInputs,
    describeGeneratedMedia,
    getGeneratedImageData,
    getGeneratedImageDataList,
    getImageTaskId,
    getImageTaskIdFromLocation,
    imageHttpErrorMessage,
    isAllVendorsFailedImageResponse,
    parseImageApiResponseText,
    imageTaskErrorMessage,
    imageTaskRetryDelayMs,
    imageTaskStatus,
    isCompletedImageTaskStatus,
    isFailedImageTaskStatus,
    isImageTaskPayload,
    isMidjourneyImagineModel,
    isMidjourneyImageModel,
    isNativeMidjourneyEndpoint,
    isRetryableImageHttpStatus,
    isRetryableImageNetworkError,
    midjourneyGridRegions,
    prependMidjourneyImagePrompts,
    shouldUseNativeMidjourneyRoute
};
