const test = require('node:test');
const assert = require('node:assert/strict');
const createLogger = require('./logger');

function captureLogs(callback) {
    const original = console.log;
    const output = [];
    console.log = value => output.push(String(value));
    try {
        callback();
        return output;
    } finally {
        console.log = original;
    }
}

test('debug level emits debug messages', () => {
    const output = captureLogs(() => {
        createLogger('Test', { level: 'debug', isProduction: false }).debug('visible');
    });
    assert.equal(output.length, 1);
    assert.match(output[0], /visible/);
});

test('production logs preserve reserved fields and nest metadata', () => {
    const output = captureLogs(() => {
        createLogger('Gateway', { level: 'info', isProduction: true })
            .info('started', { level: 'client-value', port: 8787 });
    });
    const entry = JSON.parse(output[0]);
    assert.equal(entry.level, 'info');
    assert.equal(entry.module, 'Gateway');
    assert.deepEqual(entry.meta, { level: 'client-value', port: 8787 });
});
