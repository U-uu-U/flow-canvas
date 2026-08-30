export const IMAGE_GENERATION_PREFERENCE_KEYS = Object.freeze([
    'prompt',
    'promptMergeMode',
    'negativePrompt',
    'resolutionTier',
    'ratio',
    'width',
    'height',
    'quality',
    'responseFormat',
    'historyDisabled',
    'stream',
    'style',
    'cameraControl',
    'webSearch',
    'count',
    'concurrency',
    'midjourneyPreset',
    'midjourneyVersion',
    'midjourneyRaw',
    'midjourneyQuality',
    'midjourneyStylize',
    'midjourneyChaos',
    'midjourneyWeird',
    'midjourneyImageWeight',
    'midjourneyStyleReference',
    'midjourneyStyleWeight',
    'midjourneyStyleVersion',
    'midjourneyOmniReference',
    'midjourneyOmniWeight',
    'midjourneySeed',
    'midjourneyTile',
    'midjourneyDraft',
    'midjourneyRepeat',
    'midjourneySpeed',
    'midjourneyVisibility'
]);

export const IMAGE_GENERATION_PREFERENCES_VERSION = 1;

function copyConfig(config = {}) {
    return IMAGE_GENERATION_PREFERENCE_KEYS.reduce((result, key) => {
        if (Object.prototype.hasOwnProperty.call(config, key) && config[key] !== undefined) {
            result[key] = config[key];
        }
        return result;
    }, {});
}

export function imageGenerationPreferenceKey(binding = {}) {
    const providerId = String(binding?.sourceProviderId || binding?.providerId || '').trim();
    const model = String(binding?.model || '').trim();
    return [providerId, model].filter(Boolean).join('::');
}

export function normalizeImageGenerationPreferences(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const byModel = {};
    Object.entries(source.byModel || {}).forEach(([key, record]) => {
        if (!key || !record || typeof record !== 'object') return;
        byModel[key] = {
            providerId: record.providerId || null,
            sourceProviderId: record.sourceProviderId || null,
            model: String(record.model || '').trim(),
            config: copyConfig(record.config),
            updatedAt: record.updatedAt || null
        };
    });
    return {
        version: IMAGE_GENERATION_PREFERENCES_VERSION,
        lastKey: typeof source.lastKey === 'string' && byModel[source.lastKey] ? source.lastKey : '',
        byModel
    };
}

export function getImageGenerationPreferences(value, binding = {}) {
    const preferences = normalizeImageGenerationPreferences(value);
    const key = imageGenerationPreferenceKey(binding);
    const record = (key && preferences.byModel[key])
        || (!key && preferences.lastKey ? preferences.byModel[preferences.lastKey] : null);
    return record ? { ...record.config } : null;
}

export function saveImageGenerationPreferences(value, config = {}, binding = {}) {
    const preferences = normalizeImageGenerationPreferences(value);
    const key = imageGenerationPreferenceKey(binding);
    if (!key) return preferences;

    const previous = preferences.byModel[key];
    preferences.byModel[key] = {
        providerId: binding.providerId || previous?.providerId || null,
        sourceProviderId: binding.sourceProviderId || previous?.sourceProviderId || null,
        model: String(binding.model || previous?.model || '').trim(),
        config: {
            ...(previous?.config || {}),
            ...copyConfig(config)
        },
        updatedAt: new Date().toISOString()
    };
    preferences.lastKey = key;
    return preferences;
}
