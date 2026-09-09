export const VIDEO_MODEL_PROFILES = [
    {
        matchModel: /^sd2(?:\.5|_5|-5)(?:$|-haidiyue-face$)/i,
        label: 'Seedance 2.5',
        routeLabel: '备用路线',
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
        match: /seedance[^a-z0-9]*(?:1[._-]?5|1[._-]?0[-_]?pro)/i,
        label: 'Seedance 1.5',
        ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
        resolutions: ['480p', '720p', '1080p'],
        durations: [-1, 5, 10, 12],
        durationControl: 'select',
        supportsWebSearch: false,
        defaultRatio: '16:9',
        defaultResolution: '720p',
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
    },
    {
        match: /(?:dashscope|wanx|tongyi|通义万相|wan[^\s]*(?:t2v|i2v))/i,
        label: 'DashScope',
        ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
        resolutions: ['720P', '1080P'],
        durations: [3, 5, 10, 15],
        durationControl: 'segmented',
        supportsWebSearch: false,
        defaultRatio: '1:1',
        defaultResolution: '720P',
        defaultDuration: 5
    },
    {
        match: /kling|可灵/i,
        label: 'Kling',
        ratios: ['16:9', '9:16', '1:1'],
        resolutions: [],
        durations: [3, 5, 10, 15],
        durationControl: 'segmented',
        supportsWebSearch: false,
        defaultRatio: '16:9',
        defaultResolution: null,
        defaultDuration: 5
    },
    {
        match: /tencent|vidu|腾讯/i,
        label: 'Tencent / Vidu',
        ratios: ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9'],
        resolutions: [],
        durations: [5, 10],
        durationControl: 'segmented',
        supportsWebSearch: false,
        defaultRatio: '1:1',
        defaultResolution: null,
        defaultDuration: 5
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
    const profile = VIDEO_MODEL_PROFILES.find(entry => entry.matchModel?.test(model))
        || VIDEO_MODEL_PROFILES.find(entry => entry.match?.test(marker))
        || DEFAULT_VIDEO_MODEL_PROFILE;
    let host = '';
    try { host = new URL(provider.endpoint).hostname; } catch (_) { /* Unconfigured endpoint. */ }
    if (profile === VIDEO_MODEL_PROFILES[0] && host === 'art.ravenhash.org') {
        return {
            ...profile,
            price: {
                amount: 6, currency: 'CNY', unit: 'request', kind: 'sale',
                source: 'ravenhash configured sale', updatedAt: '2026-09-06T12:38:30Z'
            }
        };
    }
    return profile;
}
