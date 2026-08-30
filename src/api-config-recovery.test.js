import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLegacyApiProviders, reconcileApiConfig } from './api-config-recovery.js';

test('legacy API merge restores missing routes without duplicating covered models', () => {
    const local = [{
        id: 'current', capability: 'text', type: 'openai', endpoint: 'https://api.test/v1/',
        apiKey: 'same', model: 'model-a', models: ['model-a', 'model-b']
    }];
    const durable = [
        { id: 'old', capability: 'text', type: 'openai', endpoint: 'https://api.test/v1', apiKey: 'same', model: 'model-b' },
        { id: 'image', capability: 'image', type: 'openai', endpoint: 'https://api.test/v1', apiKey: 'other', model: 'image-a' }
    ];

    assert.deepEqual(mergeLegacyApiProviders(local, durable).map(provider => provider.id), ['current', 'image']);
});

test('durable API config restores a new renderer origin with no local settings', () => {
    const result = reconcileApiConfig({
        localPresent: false,
        durableConfig: {
            revision: 8,
            providers: [{ id: 'restored' }],
            globalConfig: { imageProviderId: 'restored' }
        }
    });

    assert.equal(result.source, 'durable');
    assert.equal(result.providers[0].id, 'restored');
    assert.equal(result.globalConfig.imageProviderId, 'restored');
});

test('newer local revision preserves an intentional provider deletion', () => {
    const result = reconcileApiConfig({
        localPresent: true,
        localRevision: 10,
        localProviders: [],
        localGlobalConfig: {},
        durableConfig: { revision: 9, providers: [{ id: 'deleted' }] }
    });

    assert.equal(result.source, 'local');
    assert.deepEqual(result.providers, []);
});
