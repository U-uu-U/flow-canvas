const test = require('node:test');
const assert = require('node:assert/strict');
const {
    RAVENHASH_AI_BASE_URL,
    RAVENHASH_ART_BASE_URL,
    matchRavenhashBaseUrl
} = require('./routing');

test('matches only the two RavenHash Base URLs', () => {
    assert.equal(matchRavenhashBaseUrl(RAVENHASH_AI_BASE_URL), RAVENHASH_AI_BASE_URL);
    assert.equal(matchRavenhashBaseUrl(RAVENHASH_ART_BASE_URL), RAVENHASH_ART_BASE_URL);
    assert.equal(matchRavenhashBaseUrl(`  ${RAVENHASH_AI_BASE_URL}/  `), RAVENHASH_AI_BASE_URL);
    assert.equal(matchRavenhashBaseUrl(`${RAVENHASH_ART_BASE_URL}///`), RAVENHASH_ART_BASE_URL);
    assert.equal(matchRavenhashBaseUrl('HTTPS://AI.RavenHash.Org/v1'), RAVENHASH_AI_BASE_URL);
    assert.equal(matchRavenhashBaseUrl('https://ART.RAVENHASH.ORG/v1'), RAVENHASH_ART_BASE_URL);
});

test('rejects lookalike and modified RavenHash URLs', () => {
    const rejected = [
        '',
        'https://ai.ravenhash.org',
        'https://ai.ravenhash.org/v1/chat/completions',
        'https://ai.ravenhash.org/v1?paid=true',
        'https://ai.ravenhash.org/v1#paid',
        'https://ai.ravenhash.org:443/v1',
        'https://sub.ai.ravenhash.org/v1',
        'https://ai.ravenhash.org.evil.example/v1',
        'https://ai.ravenhash.org/V1',
        'https://ai.ravenhash.org/v1https://art.ravenhash.org/v1',
        'https://example.com/v1'
    ];

    for (const value of rejected) assert.equal(matchRavenhashBaseUrl(value), null, value);
});
