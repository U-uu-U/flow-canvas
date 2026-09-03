const { normalizeBaseUrl } = require('../shared/url-utils');

const RAVENHASH_BASE_URLS = new Set([
    'https://ai.ravenhash.org/v1',
    'https://art.ravenhash.org/v1'
]);

function headerValue(headers, name) {
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
    return entry?.[1];
}

function deleteHeader(headers, name) {
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
    }
}

function prepareGatewayHeaders({ requestUrl, requestHeaders, gatewayBaseUrl, readApiKey }) {
    const headers = { ...requestHeaders };
    let request;
    let gateway;
    try {
        request = new URL(requestUrl);
        gateway = new URL(gatewayBaseUrl);
    } catch (_) {
        return headers;
    }

    const gatewayPath = gateway.pathname.replace(/\/+$/, '');
    const isConfiguredGateway = request.origin === gateway.origin
        && (!gatewayPath || request.pathname === gatewayPath || request.pathname.startsWith(`${gatewayPath}/`));
    if (!isConfiguredGateway) return headers;

    deleteHeader(headers, 'authorization');
    const modelBaseUrl = normalizeBaseUrl(headerValue(headers, 'x-flowcanvas-model-base-url'));
    if (RAVENHASH_BASE_URLS.has(modelBaseUrl)) {
        const key = String(readApiKey() || '').trim();
        if (key) headers.Authorization = `Bearer ${key}`;
    }
    return headers;
}

module.exports = { prepareGatewayHeaders };
