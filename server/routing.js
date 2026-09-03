const { normalizeBaseUrl } = require('../shared/url-utils');

const RAVENHASH_AI_BASE_URL = 'https://ai.ravenhash.org/v1';
const RAVENHASH_ART_BASE_URL = 'https://art.ravenhash.org/v1';
const RAVENHASH_BASE_URLS = new Set([
    RAVENHASH_AI_BASE_URL,
    RAVENHASH_ART_BASE_URL
]);

function matchRavenhashBaseUrl(value) {
    const normalized = normalizeBaseUrl(value);
    return RAVENHASH_BASE_URLS.has(normalized) ? normalized : null;
}

module.exports = {
    RAVENHASH_AI_BASE_URL,
    RAVENHASH_ART_BASE_URL,
    matchRavenhashBaseUrl
};
