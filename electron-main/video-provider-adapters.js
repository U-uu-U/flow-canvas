function isMiniMaxH3Model(model) {
    return /minimax[^a-z0-9]*h3/i.test(String(model || ''));
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

function buildVideoGenerationEndpoint(endpoint, model) {
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
    buildVideoGenerationEndpoint,
    isMiniMaxH3Model,
    isMiniMaxH3NativeEndpoint,
    isMiniMaxH3PerSecondEndpoint,
    isMiniMaxH3UnavailableResponse,
    normalizeMiniMaxH3RequestModel
};
