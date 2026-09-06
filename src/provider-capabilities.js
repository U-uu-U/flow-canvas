export const PROVIDER_CAPABILITIES = Object.freeze({
    // Text providers also own multimodal understanding and reverse prompting.
    TEXT: 'text',
    IMAGE: 'image',
    VIDEO: 'video'
});

export function normalizeProviderCapability(value) {
    const capability = String(value || '').trim().toLowerCase();
    if (['chat', 'vision', 'multimodal', 'text-vision'].includes(capability)) {
        return PROVIDER_CAPABILITIES.TEXT;
    }
    return Object.values(PROVIDER_CAPABILITIES).includes(capability) ? capability : '';
}

export function inferProviderCapability(provider = {}) {
    const explicit = normalizeProviderCapability(provider.capability);
    if (explicit) return explicit;

    const marker = `${provider.model || ''} ${provider.endpoint || ''} ${provider.name || ''}`.toLowerCase();
    if (/(seedance|^sd2[._-]?5(?:\s|$)|artsdance|dreamina|video|kling|可灵|sora|runway|veo|vidu|minimax[^a-z0-9]*h3|hunyuan|腾讯|通义.*视频|wan[^\s]*(?:t2v|i2v))/.test(marker)) {
        return PROVIDER_CAPABILITIES.VIDEO;
    }
    if (/(image|gpt-image|dall-e|imagen|flux|stable|sdxl|midjourney)/.test(marker)) {
        return PROVIDER_CAPABILITIES.IMAGE;
    }
    return PROVIDER_CAPABILITIES.TEXT;
}

export function providerHasCapability(provider, capability) {
    return inferProviderCapability(provider) === normalizeProviderCapability(capability);
}

export function isMidjourneyImageModel(model) {
    const normalized = String(model || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    return normalized === 'mjimagine' || normalized === 'midjourney';
}

export function isGptImage2Model(model) {
    const normalized = String(model || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    return normalized === 'gptimage2';
}
