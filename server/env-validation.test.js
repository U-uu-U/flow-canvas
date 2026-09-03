const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEnv } = require('./index');

const validEnv = {
    FREE_UPSTREAM_URL: 'https://free.example/v1',
    FREE_UPSTREAM_KEY: 'server-key',
    FREE_MODEL: 'free-model'
};

test('accepts the minimum valid gateway environment', () => {
    assert.doesNotThrow(() => validateEnv(validEnv));
});

test('reports all missing required upstream settings', () => {
    assert.throws(
        () => validateEnv({}),
        /FREE_UPSTREAM_URL, FREE_UPSTREAM_KEY, FREE_MODEL/
    );
});

test('rejects unsafe URLs and invalid numeric limits', () => {
    assert.throws(
        () => validateEnv({ ...validEnv, FREE_UPSTREAM_URL: 'ftp://free.example/v1' }),
        /HTTP\(S\)/
    );
    assert.throws(
        () => validateEnv({ ...validEnv, MAX_MEDIA_UPLOAD_BYTES: 'unlimited' }),
        /必须是正数/
    );
});
