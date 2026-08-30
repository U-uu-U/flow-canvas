function providerModels(provider = {}) {
    return [...new Set([
        ...(Array.isArray(provider.models) ? provider.models : []),
        provider.model
    ].map(value => String(value || '').trim()).filter(Boolean))];
}

function normalizeEndpoint(value) {
    return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function isCoveredBy(candidate, existing) {
    if (String(candidate.apiKey || '') !== String(existing.apiKey || '')) return false;
    if (normalizeEndpoint(candidate.endpoint) !== normalizeEndpoint(existing.endpoint)) return false;
    if (String(candidate.type || 'openai') !== String(existing.type || 'openai')) return false;
    if (String(candidate.capability || '') !== String(existing.capability || '')) return false;
    const existingModels = new Set(providerModels(existing));
    return providerModels(candidate).every(model => existingModels.has(model));
}

export function mergeLegacyApiProviders(localProviders = [], durableProviders = []) {
    const merged = Array.isArray(localProviders) ? localProviders.map(provider => ({ ...provider })) : [];
    (Array.isArray(durableProviders) ? durableProviders : []).forEach(provider => {
        if (!provider || typeof provider !== 'object') return;
        if (merged.some(existing => existing.id && existing.id === provider.id)) return;
        if (merged.some(existing => isCoveredBy(provider, existing))) return;
        merged.push({ ...provider });
    });
    return merged;
}

export function reconcileApiConfig({
    localProviders = [],
    localGlobalConfig = {},
    localPresent = false,
    localRevision = 0,
    durableConfig = null
} = {}) {
    const durableRevision = Math.max(0, Number(durableConfig?.revision) || 0);
    const normalizedLocalRevision = Math.max(0, Number(localRevision) || 0);
    if (!durableConfig) {
        return {
            providers: Array.isArray(localProviders) ? localProviders : [],
            globalConfig: localGlobalConfig || {},
            revision: Math.max(1, normalizedLocalRevision),
            source: 'local'
        };
    }

    if (!localPresent || durableRevision > normalizedLocalRevision) {
        return {
            providers: Array.isArray(durableConfig.providers) ? durableConfig.providers : [],
            globalConfig: durableConfig.globalConfig || {},
            revision: Math.max(1, durableRevision),
            source: 'durable'
        };
    }

    if (normalizedLocalRevision > 0) {
        return {
            providers: Array.isArray(localProviders) ? localProviders : [],
            globalConfig: localGlobalConfig || {},
            revision: normalizedLocalRevision,
            source: 'local'
        };
    }

    return {
        providers: mergeLegacyApiProviders(localProviders, durableConfig.providers),
        globalConfig: { ...(durableConfig.globalConfig || {}), ...(localGlobalConfig || {}) },
        revision: Math.max(1, durableRevision),
        source: 'merged'
    };
}
