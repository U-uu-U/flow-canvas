export const VIDEO_MODEL_PROFILES = [
    {
        matchModel: /^sd2(?:\.5|_5|-5)(?:-route[12]|-haidiyue-face)?$/i,
        label: 'Seedance 2.5',
        routeLabel: '线路二',
        routeGroup: 'seedance25-fixed',
        routeModelLabel: 'sd2.5',
        ratios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'],
        resolutions: ['720p'],
        durations: [30],
        durationControl: 'fixed',
        supportsWebSearch: false,
        supportsCameraFixed: false,
        supportsGeneratedAudio: false,
        supportsWatermark: false,
        referenceLimits: { image: 9, video: 0, audio: 0 },
        defaultRatio: 'adaptive',
        resolveAdaptiveRatio: true,
        adaptiveFallbackRatio: '16:9',
        defaultResolution: '720p',
        defaultDuration: 30
    },
    {
        matchModel: /^seedance_v2\.5$/i,
        label: 'HM-Seedance 2.5',
        ratios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'],
        resolutions: ['720p'],
        durations: Array.from({ length: 27 }, (_, index) => index + 4),
        durationControl: 'slider',
        supportsWebSearch: false,
        supportsCameraFixed: false,
        supportsGeneratedAudio: false,
        supportsWatermark: false,
        referenceLimits: { image: 10, video: 0, audio: 0 },
        defaultRatio: 'adaptive',
        resolveAdaptiveRatio: true,
        adaptiveFallbackRatio: '16:9',
        defaultResolution: '720p',
        defaultDuration: 30
    },
    ...[
        ['seedance_v2.0-933', 'HM-Seedance V2.0 933', 15, 9, 3, 3],
        ['seedance_v2.5-101010', 'HM-Seedance V2.5 101010', 30, 10, 10, 10],
        ['seedance_v2.5-301010', 'HM-Seedance V2.5 301010', 30, 30, 10, 10]
    ].map(([model, label, maxDuration, image, video, audio]) => ({
        matchModel: new RegExp(`^${model.replaceAll('.', '\\.')}$`, 'i'),
        label,
        faceRestriction: true,
        ratios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'],
        resolutions: ['720p'],
        durations: Array.from({ length: maxDuration - 3 }, (_, index) => index + 4),
        durationControl: 'slider',
        supportsWebSearch: false,
        supportsCameraFixed: false,
        supportsGeneratedAudio: false,
        supportsWatermark: false,
        referenceLimits: { image, video, audio },
        defaultRatio: 'adaptive',
        resolveAdaptiveRatio: true,
        adaptiveFallbackRatio: '16:9',
        defaultResolution: '720p',
        defaultDuration: maxDuration
    })),
    {
        match: /seedance[^a-z0-9]*(?:v[^a-z0-9]*)?2[._-]?5/i,
        label: 'Seedance 2.5',
        ratios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'],
        resolutions: ['720p'],
        durations: Array.from({ length: 27 }, (_, index) => index + 4),
        durationControl: 'slider',
        supportsWebSearch: false,
        supportsCameraFixed: false,
        supportsGeneratedAudio: false,
        supportsWatermark: false,
        referenceLimits: { image: 10, video: 0, audio: 0 },
        defaultRatio: 'adaptive',
        resolveAdaptiveRatio: true,
        adaptiveFallbackRatio: '16:9',
        defaultResolution: '720p',
        defaultDuration: 30
    },
    {
        match: /seedance[^a-z0-9]*2(?:[._-]?0)?|doubao-seedance-2|artsdance[^a-z0-9]*2/i,
        label: 'Seedance 2.0',
        ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
        resolutions: ['480p', '720p', '1080p', '4K'],
        durations: Array.from({ length: 15 }, (_, index) => index + 1),
        durationControl: 'slider',
        supportsWebSearch: true,
        defaultRatio: '16:9',
        defaultResolution: '1080p',
        defaultDuration: 5
    },
    {
        match: /minimax[^a-z0-9]*h3/i,
        label: 'MiniMax H3',
        ratios: ['adaptive', '16:9', '9:16', '1:1', '2:3', '3:2', '4:3', '3:4', '21:9'],
        resolutions: ['2k', '4k', '1080p', '768p', '480p'],
        durations: Array.from({ length: 12 }, (_, index) => index + 4),
        durationControl: 'slider',
        supportsWebSearch: false,
        supportsCameraFixed: false,
        supportsGeneratedAudio: false,
        supportsWatermark: false,
        referenceLimits: { image: 9, video: 3, audio: 3 },
        defaultRatio: 'adaptive',
        resolveAdaptiveRatio: true,
        adaptiveFallbackRatio: '16:9',
        defaultResolution: '2k',
        defaultDuration: 4
    }
];

export const DEFAULT_VIDEO_MODEL_PROFILE = {
    label: '未收录模型',
    ratios: [],
    resolutions: [],
    durations: [],
    durationControl: null,
    supportsWebSearch: false,
    supportsCameraFixed: false,
    supportsGeneratedAudio: false,
    supportsWatermark: false,
    defaultRatio: null,
    defaultResolution: null,
    defaultDuration: null
};

export function getVideoModelProfile(provider) {
    if (!provider?.model) return null;
    const model = String(provider.model).trim();
    const marker = `${provider.model} ${provider.name || ''} ${provider.endpoint || ''}`;
    let profile = VIDEO_MODEL_PROFILES.find(entry => entry.matchModel?.test(model))
        || VIDEO_MODEL_PROFILES.find(entry => entry.match?.test(marker))
        || DEFAULT_VIDEO_MODEL_PROFILE;
    let host = '';
    try { host = new URL(provider.endpoint).hostname; } catch (_) { /* Unconfigured endpoint. */ }
    const fixedSeedance = profile === VIDEO_MODEL_PROFILES[0];
    if (fixedSeedance) {
        profile = { ...profile, routeLabel: /-route1$/i.test(model) ? '线路一' : '线路二' };
    }
    if (fixedSeedance && host === 'art.ravenhash.org') {
        return {
            ...profile,
            price: {
                amount: 6, currency: 'CNY', unit: 'request', kind: 'sale',
                source: 'ravenhash configured sale', updatedAt: '2026-09-06T12:38:30Z'
            }
        };
    }
    const hmPrice = {
        'seedance_v2.5': 5,
        'seedance_v2.0-933': 6.5,
        'seedance_v2.5-101010': 7,
        'seedance_v2.5-301010': 10
    }[model.toLowerCase()];
    if (hmPrice && host === 'art.ravenhash.org') {
        return { ...profile, price: {
            amount: hmPrice, currency: 'CNY', unit: 'request', kind: 'sale',
            source: 'ravenhash configured sale', updatedAt: '2026-09-12T11:30:00Z'
        } };
    }
    return profile;
}

export function describeVideoModelProfile(profile) {
    if (!profile) return '';
    const parts = [];
    if (profile.faceRestriction) parts.push('人脸参考受限');
    if (profile.resolutions?.length) parts.push(profile.resolutions.join('/'));
    if (profile.durations?.length) {
        const min = Math.min(...profile.durations);
        const max = Math.max(...profile.durations);
        parts.push(min === max ? `固定 ${max} 秒` : `${min}-${max} 秒`);
    }
    if (profile.referenceLimits) {
        const { image = 0, video = 0, audio = 0 } = profile.referenceLimits;
        const media = [image ? `${image} 图` : '', video ? `${video} 视频` : '', audio ? `${audio} 音频` : ''].filter(Boolean);
        if (media.length) parts.push(`最多 ${media.join(' / ')}参考`);
        if (!video && !audio) parts.push('不支持音视频参考');
    }
    const price = profile.price;
    if (price?.kind === 'sale' && price.source && price.currency === 'CNY' && price.unit === 'request') {
        parts.push(`¥${price.amount}/次`);
    }
    return parts.join('；');
}
