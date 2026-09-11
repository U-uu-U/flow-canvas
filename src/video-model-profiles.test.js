import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VIDEO_MODEL_PROFILE, getVideoModelProfile } from '../shared/video-model-profiles.mjs';
import { inferProviderCapability } from './provider-capabilities.js';

test('HM profile preserves limits without advertising upstream cost', () => {
    const profile = getVideoModelProfile({ model: 'seedance_v2.5', endpoint: 'https://art.ravenhash.org/v1' });
    assert.equal(profile.price, undefined);
    assert.equal(profile.referenceLimits.image, 10);
    assert.equal(profile.defaultDuration, 30);
    assert.deepEqual(profile.resolutions, ['720p']);
});

test('sd2.5 sale is restricted to the exact RavenHash art host', () => {
    const provider = { model: 'sd2.5', endpoint: 'https://art.ravenhash.org/v1' };
    assert.deepEqual(getVideoModelProfile(provider).price, {
        amount: 6, currency: 'CNY', unit: 'request', kind: 'sale', source: 'ravenhash configured sale', updatedAt: '2026-09-06T12:38:30Z'
    });
    for (const endpoint of ['https://ai.ravenhash.org/v1', 'https://art.ravenhash.org.example/v1', 'https://other.test', 'invalid']) {
        assert.equal(getVideoModelProfile({ ...provider, endpoint }).price, undefined);
    }
    assert.equal(getVideoModelProfile({ ...provider, model: 'sd2.5-haidiyue-face' }).price.amount, 6);
});

test('profile lookup retains matching, defaults and capability constraints', () => {
    assert.equal(getVideoModelProfile({ model: 'unknown' }), DEFAULT_VIDEO_MODEL_PROFILE);
    assert.equal(getVideoModelProfile({}), null);
    assert.equal(getVideoModelProfile({ model: 'doubao-seedance-2-0' }).supportsWebSearch, true);
    assert.equal(getVideoModelProfile({ model: 'minimax-h3' }).referenceLimits.audio, 3);
});

test('fixed-duration routes retain the same CNY sale and media capabilities', () => {
    for (const [model, label] of [['sd2.5-route1', '线路一'], ['sd2.5', '线路二']]) {
        const provider = { model, endpoint: 'https://art.ravenhash.org/v1' };
        const profile = getVideoModelProfile(provider);
        assert.equal(inferProviderCapability(provider), 'video');
        assert.equal(profile.routeLabel, label);
        assert.equal(profile.routeGroup, 'seedance25-fixed');
        assert.deepEqual(profile.durations, [30]);
        assert.deepEqual(profile.resolutions, ['720p']);
        assert.equal(profile.referenceLimits.image, 9);
        assert.equal(profile.price.amount, 6);
        assert.equal(profile.price.currency, 'CNY');
    }
});
