function isMiniMaxH3Model(model) {
    return /minimax[^a-z0-9]*h3/i.test(String(model || ''));
}

function isSeedance25BackupModel(model) {
    return /^sd2(?:\.5|_5|-5)(?:-route[12]|-haidiyue-face)?$/i.test(String(model || '').trim());
}

function isSeedance25Model(model) {
    return isSeedance25BackupModel(model)
        || /seedance[^a-z0-9]*(?:v[^a-z0-9]*)?2[._-]?5/i.test(String(model || ''));
}

function isSeedanceVideoModel(model) {
    return isSeedance25Model(model) || /^seedance_v2\.0-933$/i.test(String(model || '').trim());
}

function seedanceReferenceLimits(model) {
    const id = String(model || '').trim().toLowerCase();
    if (id === 'seedance_v2.0-933') return { image: 9, video: 3, audio: 3 };
    if (id === 'seedance_v2.5-101010') return { image: 10, video: 10, audio: 10 };
    if (id === 'seedance_v2.5-301010') return { image: 30, video: 10, audio: 10 };
    return { image: isSeedance25BackupModel(model) ? 9 : 10, video: 0, audio: 0 };
}

function seedance25ReferenceImageLimit(model) {
    return seedanceReferenceLimits(model).image;
}

function resolveSeedance25AspectRatio(selectedRatio, width, height) {
    const selected = String(selectedRatio || '').trim();
    if (selected && selected !== 'adaptive') return selected;

    const numericWidth = Number(width);
    const numericHeight = Number(height);
    if (!(numericWidth > 0) || !(numericHeight > 0)) return '16:9';

    const actual = numericWidth / numericHeight;
    const ratios = ['16:9', '9:16', '1:1', '4:3', '3:4'];
    return ratios.reduce((closest, candidate) => {
        const [candidateWidth, candidateHeight] = candidate.split(':').map(Number);
        const [closestWidth, closestHeight] = closest.split(':').map(Number);
        const candidateDistance = Math.abs(Math.log(actual / (candidateWidth / candidateHeight)));
        const closestDistance = Math.abs(Math.log(actual / (closestWidth / closestHeight)));
        return candidateDistance < closestDistance ? candidate : closest;
    }, ratios[0]);
}

function videoPayloadObject(payload, key) {
    const value = payload?.[key];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function getVideoTaskId(payload) {
    const data = videoPayloadObject(payload, 'data');
    const result = videoPayloadObject(payload, 'result');
    const value = payload?.task_id || payload?.id
        || data?.task_id || data?.id
        || result?.task_id || result?.id;
    return value == null ? '' : String(value).trim();
}

function getVideoTaskStatus(payload) {
    const data = videoPayloadObject(payload, 'data');
    const result = videoPayloadObject(payload, 'result');
    const output = videoPayloadObject(payload, 'output');
    return String(payload?.status || data?.status || result?.status || output?.status || '').trim();
}

function getVideoTaskProgress(payload) {
    const data = videoPayloadObject(payload, 'data');
    const result = videoPayloadObject(payload, 'result');
    const output = videoPayloadObject(payload, 'output');
    return payload?.progress ?? data?.progress ?? result?.progress ?? output?.progress ?? null;
}

function getVideoResultUrl(payload) {
    const data = videoPayloadObject(payload, 'data');
    const result = videoPayloadObject(payload, 'result');
    const output = videoPayloadObject(payload, 'output');
    const video = videoPayloadObject(payload, 'video');
    const content = videoPayloadObject(payload, 'content');
    const dataItems = Array.isArray(payload?.data) ? payload.data : [];
    const firstData = dataItems[0] || null;
    const firstContent = Array.isArray(payload?.content) ? payload.content[0] : null;
    const statusUrls = new Set([
        payload?.status_url, data?.status_url, result?.status_url, output?.status_url
    ].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()));
    const arrayDataCandidates = dataItems.flatMap(item => {
        if (typeof item === 'string') return [item];
        if (!item || typeof item !== 'object') return [];
        return [
            item.video_url, item.result_url, item.output_url,
            item.download_url, item.url
        ];
    });
    const candidates = [
        typeof firstData === 'string' ? firstData : null,
        firstData?.video_url, firstData?.result_url, firstData?.output_url,
        firstData?.download_url, firstData?.url,
        ...arrayDataCandidates,
        typeof firstContent === 'string' ? firstContent : null,
        firstContent?.video_url, firstContent?.url,
        content?.video_url, content?.url,
        payload?.video_url, payload?.result_url, payload?.output_url, payload?.download_url, payload?.url,
        video?.video_url, video?.download_url, video?.url,
        data?.video_url, data?.result_url, data?.output_url, data?.download_url, data?.url,
        result?.video_url, result?.result_url, result?.output_url, result?.download_url, result?.url,
        output?.video_url, output?.result_url, output?.output_url, output?.download_url, output?.url,
        payload?.metadata?.url
    ];
    const taskId = getVideoTaskId(payload);
    return candidates.find(value => {
        if (typeof value !== 'string' || !value.trim()) return false;
        const normalized = value.trim();
        if (statusUrls.has(normalized)) return false;
        if (!taskId) return true;
        try {
            const pathname = new URL(normalized).pathname.replace(/\/+$/, '');
            return !pathname.endsWith(`/${encodeURIComponent(taskId)}`)
                && !pathname.endsWith(`/${taskId}`);
        } catch (_) {
            return true;
        }
    }) || '';
}

function getVideoPayloadError(payload = {}) {
    const data = videoPayloadObject(payload, 'data');
    const result = videoPayloadObject(payload, 'result');
    const error = payload?.error ?? data?.error ?? result?.error;
    const message = typeof error === 'string'
        ? error
        : error?.message || payload?.message || payload?.msg || data?.message || result?.message || '';
    const status = getVideoTaskStatus(payload).toLowerCase();
    if (['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(status)) {
        return String(message || '服务端未提供失败原因').trim();
    }

    // Some OpenAI-compatible video relays report upstream failures as HTTP 200
    // with only an error object and no top-level status/code.
    if (error && message) return String(message).trim();

    const code = String(payload?.code ?? data?.code ?? result?.code ?? '').trim().toLowerCase();
    if (message && code && !['0', '1', '200', 'success', 'ok'].includes(code)) {
        return String(message).trim();
    }
    return '';
}

function buildSeedance25RequestBody({
    model,
    prompt,
    duration,
    aspectRatio,
    referenceImages = [],
    referenceVideos = [],
    referenceAudios = []
    } = {}) {
    const label = /^seedance_v2\.0-933$/i.test(String(model || '').trim()) ? 'Seedance 2.0' : 'Seedance 2.5';
    const maxDuration = label === 'Seedance 2.0' ? 15 : 30;
    const promptValue = String(prompt || '').trim();
    if (!promptValue) throw new Error(`${label} 提示词不能为空`);

    const durationValue = duration === undefined || duration === null || duration === ''
        ? maxDuration
        : Number(duration);
    if (isSeedance25BackupModel(model)) {
        if (durationValue !== 30) {
            throw new Error('Seedance 2.5 备用路线仅支持固定 30 秒视频');
        }
    } else if (!Number.isInteger(durationValue) || durationValue < 4 || durationValue > maxDuration) {
        throw new Error(`${label} 时长仅支持 4 到 ${maxDuration} 秒的整数`);
    }

    const images = Array.isArray(referenceImages)
        ? referenceImages
            .map(image => typeof image === 'string' ? image : image?.url)
            .map(image => String(image || '').trim())
            .filter(Boolean)
        : [];
    const referenceImageLimit = seedance25ReferenceImageLimit(model);
    if (images.length > referenceImageLimit) {
        throw new Error(`${label} 最多支持 ${referenceImageLimit} 张参考图片`);
    }
    const urls = values => (Array.isArray(values) ? values : [])
        .map(value => String(typeof value === 'string' ? value : value?.url || '').trim()).filter(Boolean);
    const videos = urls(referenceVideos);
    const audios = urls(referenceAudios);
    const limits = seedanceReferenceLimits(model);
    if (videos.length > limits.video) throw new Error(`${label} 最多支持 ${limits.video} 个参考视频`);
    if (audios.length > limits.audio) throw new Error(`${label} 最多支持 ${limits.audio} 段参考音频`);

    const ratioValue = aspectRatio == null ? '' : String(aspectRatio).trim();
    const allowedRatios = ['16:9', '9:16', '1:1', '4:3', '3:4'];
    if (ratioValue && !allowedRatios.includes(ratioValue)) {
        throw new Error(`${label} 不支持画幅比例 ${ratioValue}`);
    }

    const body = {
        model: String(model || '').trim(),
        prompt: promptValue,
        resolution: '720p',
        seconds: durationValue
    };
    if (ratioValue) body.ratio = ratioValue;
    if (images.length > 0) body.image_urls = images;
    if (videos.length > 0) body.video_urls = videos;
    if (audios.length > 0) body.audio_urls = audios;
    return body;
}

function videoModelFilePrefix(model) {
    const value = String(model || '').trim();
    if (isMiniMaxH3Model(value)) return 'minimax_h3';
    if (isSeedance25Model(value)) return 'seedance_2_5';
    if (/seedance[^a-z0-9]*(?:v)?2(?:[._-]?0)?|doubao-seedance-2|artsdance[^a-z0-9]*2/i.test(value)) {
        return 'seedance_2_0';
    }
    const normalized = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
    return normalized || 'video';
}

function isMiniMaxH3NativeEndpoint(endpoint) {
    try {
        const url = new URL(String(endpoint || '').trim());
        return /\/kyyReactApiServer\/v2\/model-center\/tasks\/?$/i.test(url.pathname);
    } catch (_) {
        return false;
    }
}

function isMiniMaxH3PerSecondEndpoint(endpoint) {
    try {
        const url = new URL(String(endpoint || '').trim());
        return /\/v1\/videos\/?$/i.test(url.pathname);
    } catch (_) {
        return false;
    }
}

function buildOpenAiVideoEndpoint(endpoint) {
    const raw = String(endpoint || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        let pathName = url.pathname.replace(/\/+$/, '');
        if (!pathName || pathName === '/') {
            pathName = '/v1/video/generations';
        } else if (/\/v1$/i.test(pathName)) {
            pathName += '/video/generations';
        } else if (/\/(?:chat\/completions|responses|completions|models|images\/(?:generations|edits))$/i.test(pathName)) {
            pathName = pathName.replace(/\/(?:chat\/completions|responses|completions|models|images\/(?:generations|edits))$/i, '/video/generations');
        } else if (!/\/video\/generations$/i.test(pathName)) {
            pathName += '/video/generations';
        }
        url.pathname = pathName;
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch (_) {
        return raw;
    }
}

function buildUnifiedVideoEndpoint(endpoint) {
    const raw = String(endpoint || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        let pathName = url.pathname.replace(/\/+$/, '');
        if (!pathName || pathName === '/') {
            pathName = '/v1/videos';
        } else if (/\/v1$/i.test(pathName)) {
            pathName += '/videos';
        } else if (/\/video\/generations$/i.test(pathName)) {
            pathName = pathName.replace(/\/video\/generations$/i, '/videos');
        } else if (/\/(?:chat\/completions|responses|completions|models|images\/(?:generations|edits))$/i.test(pathName)) {
            pathName = pathName.replace(/\/(?:chat\/completions|responses|completions|models|images\/(?:generations|edits))$/i, '/videos');
        } else if (!/\/videos$/i.test(pathName)) {
            pathName += '/videos';
        }
        url.pathname = pathName;
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch (_) {
        return raw;
    }
}

function buildVideoGenerationEndpoint(endpoint, model) {
    if (isSeedanceVideoModel(model)) {
        try {
            const url = new URL(String(endpoint || '').trim());
            const isDirectUpstream = url.hostname.toLowerCase() === 'video.zhubo.asia'
                || /\/v1\/videos\/?$/i.test(url.pathname);
            return isDirectUpstream
                ? buildUnifiedVideoEndpoint(endpoint)
                : buildOpenAiVideoEndpoint(endpoint);
        } catch (_) {
            return buildOpenAiVideoEndpoint(endpoint);
        }
    }
    if (!isMiniMaxH3Model(model)) return buildOpenAiVideoEndpoint(endpoint);
    if (isMiniMaxH3NativeEndpoint(endpoint) || isMiniMaxH3PerSecondEndpoint(endpoint)) {
        return String(endpoint).trim();
    }
    return buildOpenAiVideoEndpoint(endpoint);
}

function normalizeMiniMaxH3RequestModel(model, endpoint) {
    const value = String(model || '').trim();
    if (!isMiniMaxH3NativeEndpoint(endpoint) || !isMiniMaxH3Model(value)) return value;
    return 'MiniMax-H3-c1';
}

const MINIMAX_H3_STANDARD_SIZES = {
    '480p': {
        '16:9': '864x480', '9:16': '480x864', '1:1': '640x640', '2:3': '544x800',
        '3:2': '800x544', '3:4': '576x736', '4:3': '736x576', '21:9': '992x416'
    },
    '768p': {
        '16:9': '1376x768', '9:16': '768x1376', '1:1': '1024x1024', '2:3': '832x1248',
        '3:2': '1248x832', '3:4': '896x1184', '4:3': '1184x896', '21:9': '1568x672'
    },
    '1080p': {
        '16:9': '1920x1088', '9:16': '1088x1920', '1:1': '1440x1440', '2:3': '1184x1760',
        '3:2': '1760x1184', '3:4': '1248x1664', '4:3': '1664x1248', '21:9': '2208x960'
    }
};

function normalizeMiniMaxH3PerSecondResolution(resolution) {
    const value = String(resolution || '2k').trim().toLowerCase();
    // Keep old 720p nodes usable with the upstream's nearest documented tier.
    if (value === '720p') return '768p';
    if (['480p', '768p', '1080p', '2k', '4k'].includes(value)) return value;
    throw new Error(`MiniMax H3 不支持输出分辨率 ${resolution}`);
}

function buildMiniMaxH3PerSecondBody({
    model,
    prompt,
    duration,
    aspectRatio,
    resolution,
    referenceImages,
    referenceVideos,
    referenceAudios
}) {
    const ratio = String(aspectRatio || '16:9').trim();
    const resolutionTier = normalizeMiniMaxH3PerSecondResolution(resolution);
    const upscaled = resolutionTier === '2k' || resolutionTier === '4k';
    const hasImages = referenceImages.length > 0;
    const hasVideoOrAudio = referenceVideos.length > 0 || referenceAudios.length > 0;
    const firstLastFrame = hasImages && referenceImages.length <= 2 && !hasVideoOrAudio;
    const workflow = upscaled
        ? (firstLastFrame ? 'cf-fl2v' : 'cf-multi-reference')
        : (!hasImages && !hasVideoOrAudio
            ? 'text-to-video'
            : (firstLastFrame ? 'fl2v' : 'multi-reference'));
    const size = upscaled
        ? resolutionTier.toUpperCase()
        : MINIMAX_H3_STANDARD_SIZES[resolutionTier]?.[ratio];
    if (!size) throw new Error(`MiniMax H3 的 ${resolutionTier} 不支持画幅比例 ${ratio}`);

    const body = {
        model: String(model || '').trim(),
        prompt,
        seconds: duration,
        workflow_id: workflow,
        size
    };
    if (upscaled) body.aspect_ratio = ratio;
    if (referenceImages.length > 0) body.images = referenceImages;
    if (referenceVideos.length === 1) body.reference_video = referenceVideos[0];
    if (referenceVideos.length > 1) body.reference_videos = referenceVideos;
    if (referenceAudios.length === 1) body.reference_audio = referenceAudios[0];
    if (referenceAudios.length > 1) body.reference_audios = referenceAudios;
    return body;
}

function buildMiniMaxH3RelayBody({
    model,
    prompt,
    duration,
    aspectRatio,
    resolution,
    referenceImages,
    referenceVideos,
    referenceAudios
}) {
    const body = {
        model: String(model || '').trim(),
        prompt,
        resolution: normalizeMiniMaxH3PerSecondResolution(resolution),
        duration
    };
    if (aspectRatio) body.aspect_ratio = aspectRatio;
    if (referenceImages.length === 1) {
        body.first_image = referenceImages[0];
    } else if (referenceImages.length === 2) {
        body.first_image = referenceImages[0];
        body.last_image = referenceImages[1];
    } else if (referenceImages.length > 2) {
        body.reference_images = referenceImages;
    }
    if (referenceVideos.length > 0) body.reference_videos = referenceVideos;
    if (referenceAudios.length > 0) body.reference_audios = referenceAudios;
    return body;
}

function buildMiniMaxH3RequestBody({
    endpoint,
    model,
    prompt,
    duration,
    aspectRatio,
    resolution,
    referenceImages = [],
    referenceVideos = [],
    referenceAudios = []
} = {}) {
    const promptValue = String(prompt || '').trim();
    if (!promptValue) throw new Error('MiniMax H3 提示词不能为空');
    if (promptValue.length > 5000) throw new Error('MiniMax H3 提示词不能超过 5000 个字符');

    const durationValue = duration === undefined || duration === null || duration === ''
        ? 4
        : Number(duration);
    if (!Number.isInteger(durationValue) || durationValue < 4 || durationValue > 15) {
        throw new Error('MiniMax H3 视频时长必须在 4 到 15 秒之间');
    }

    const ratioValue = String(aspectRatio || '16:9').trim();
    const allowedRatios = ['16:9', '9:16', '1:1', '2:3', '3:2', '4:3', '3:4', '21:9'];
    if (!allowedRatios.includes(ratioValue)) {
        throw new Error(`MiniMax H3 不支持画幅比例 ${ratioValue}`);
    }

    const imageUrls = referenceImages.map(String).map(value => value.trim()).filter(Boolean);
    const videoUrls = referenceVideos.map(String).map(value => value.trim()).filter(Boolean);
    const audioUrls = referenceAudios.map(String).map(value => value.trim()).filter(Boolean);
    if (imageUrls.length > 9) throw new Error('MiniMax H3 最多支持 9 张参考图片');
    if (videoUrls.length > 3) throw new Error('MiniMax H3 最多支持 3 个参考视频');
    if (audioUrls.length > 3) throw new Error('MiniMax H3 最多支持 3 个参考音频');

    if (isMiniMaxH3PerSecondEndpoint(endpoint)) {
        return buildMiniMaxH3PerSecondBody({
            model,
            prompt: promptValue,
            duration: durationValue,
            aspectRatio: ratioValue,
            resolution,
            referenceImages: imageUrls,
            referenceVideos: videoUrls,
            referenceAudios: audioUrls
        });
    }
    if (!isMiniMaxH3NativeEndpoint(endpoint)) {
        return buildMiniMaxH3RelayBody({
            model,
            prompt: promptValue,
            duration: durationValue,
            aspectRatio: ratioValue,
            resolution,
            referenceImages: imageUrls,
            referenceVideos: videoUrls,
            referenceAudios: audioUrls
        });
    }
    if (videoUrls.length > 0) throw new Error('MiniMax H3 当前任务中心直连接口不支持参考视频');

    const body = {
        model: normalizeMiniMaxH3RequestModel(model, endpoint),
        prompt: promptValue,
        duration: durationValue,
        aspect_ratio: ratioValue,
        resolution: '720p'
    };
    if (imageUrls.length > 0) body.reference_images = imageUrls;
    if (audioUrls.length > 0) body.reference_audios = audioUrls;
    return body;
}

function buildMiniMaxH3TaskEndpoint(generationEndpoint, taskId) {
    const url = new URL(generationEndpoint);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encodeURIComponent(taskId)}`;
    url.search = '';
    url.hash = '';
    return url.toString();
}

function isMiniMaxH3UnavailableResponse(statusCode, responseText = '') {
    if (Number(statusCode) !== 400) return false;
    return /模型不可用|model[^\n]{0,40}(?:unavailable|not available)|upstream_error/i
        .test(String(responseText || ''));
}

module.exports = {
    buildMiniMaxH3RequestBody,
    buildMiniMaxH3TaskEndpoint,
    buildOpenAiVideoEndpoint,
    buildSeedance25RequestBody,
    buildVideoGenerationEndpoint,
    getVideoPayloadError,
    getVideoResultUrl,
    getVideoTaskId,
    getVideoTaskProgress,
    getVideoTaskStatus,
    isMiniMaxH3Model,
    isMiniMaxH3NativeEndpoint,
    isMiniMaxH3PerSecondEndpoint,
    isMiniMaxH3UnavailableResponse,
    isSeedance25BackupModel,
    isSeedance25Model,
    isSeedanceVideoModel,
    seedanceReferenceLimits,
    normalizeMiniMaxH3RequestModel,
    resolveSeedance25AspectRatio,
    seedance25ReferenceImageLimit,
    videoModelFilePrefix
};
