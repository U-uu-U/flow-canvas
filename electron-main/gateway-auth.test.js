const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareGatewayHeaders } = require('./gateway-auth');
const { normalizeBaseUrl } = require('../shared/url-utils');

test('normalizes only scheme and hostname case', () => {
    assert.equal(normalizeBaseUrl('HTTPS://AI.RavenHash.Org/v1/'), 'https://ai.ravenhash.org/v1');
    assert.equal(normalizeBaseUrl('https://ai.ravenhash.org/V1'), 'https://ai.ravenhash.org/V1');
    assert.equal(normalizeBaseUrl('https://ai.ravenhash.org:443/v1'), 'https://ai.ravenhash.org:443/v1');
});

test('injects the Key only for a RavenHash route to the configured gateway', () => {
    const headers = prepareGatewayHeaders({
        requestUrl: 'https://gateway.example/api/v1/images/generations',
        gatewayBaseUrl: 'https://gateway.example/api',
        requestHeaders: {
            'X-FlowCanvas-Model-Base-URL': 'HTTPS://ART.RavenHash.Org/v1',
            Authorization: 'Bearer renderer-value'
        },
        readApiKey: () => 'safe-storage-key'
    });
    assert.equal(headers.Authorization, 'Bearer safe-storage-key');
});

test('removes renderer Authorization from free gateway routes', () => {
    const headers = prepareGatewayHeaders({
        requestUrl: 'https://gateway.example/v1/chat/completions',
        gatewayBaseUrl: 'https://gateway.example',
        requestHeaders: {
            'X-FlowCanvas-Model-Base-URL': 'https://example.com/v1',
            Authorization: 'Bearer renderer-value'
        },
        readApiKey: () => 'safe-storage-key'
    });
    assert.equal(Object.keys(headers).some(key => key.toLowerCase() === 'authorization'), false);
});

test('never injects the Key into an unconfigured destination', () => {
    const headers = prepareGatewayHeaders({
        requestUrl: 'https://attacker.example/collect',
        gatewayBaseUrl: 'https://gateway.example',
        requestHeaders: { 'X-FlowCanvas-Model-Base-URL': 'https://ai.ravenhash.org/v1' },
        readApiKey: () => 'safe-storage-key'
    });
    assert.equal(Object.values(headers).includes('Bearer safe-storage-key'), false);
});
