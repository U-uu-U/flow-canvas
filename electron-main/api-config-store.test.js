const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ApiConfigStore } = require('./api-config-store');

function createStore(root) {
    return new ApiConfigStore(root, {
        protect: value => Buffer.from(value, 'utf8').map(byte => byte ^ 0x5a),
        unprotect: value => Buffer.from(value).map(byte => byte ^ 0x5a).toString('utf8'),
        now: () => new Date('2026-08-30T12:00:00.000Z')
    });
}

test('ApiConfigStore encrypts credentials and restores the latest config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-canvas-api-config-'));
    try {
        const store = createStore(root);
        const result = store.save({
            revision: 4,
            providers: [{ id: 'image', apiKey: 'secret-value', model: 'gpt-image-2' }],
            globalConfig: { imageProviderId: 'image' }
        });

        assert.equal(result.success, true);
        const raw = fs.readFileSync(path.join(root, 'data', 'api-config.v1.json'), 'utf8');
        assert.equal(raw.includes('secret-value'), false);
        const loaded = store.load();
        assert.equal(loaded.config.providers[0].apiKey, 'secret-value');
        assert.equal(loaded.config.revision, 4);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('ApiConfigStore falls back to a rotated backup when the primary is corrupt', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-canvas-api-config-'));
    try {
        const store = createStore(root);
        store.save({ revision: 1, providers: [{ id: 'first', apiKey: 'one' }] });
        store.save({ revision: 2, providers: [{ id: 'second', apiKey: 'two' }] });
        fs.writeFileSync(path.join(root, 'data', 'api-config.v1.json'), '{broken', 'utf8');

        const loaded = store.load();
        assert.equal(loaded.success, true);
        assert.equal(loaded.recoveredFromBackup, true);
        assert.equal(loaded.config.providers[0].id, 'first');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
