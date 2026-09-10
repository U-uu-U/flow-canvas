const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiagnosticLog, sanitize } = require('./diagnostics.cjs');
function setup(t, options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-debug-'));
    const log = new DiagnosticLog(dir, options);
    t.after(() => { log.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { log, dir };
}
test('diagnostics redact credentials, URL queries and media but retain correlation IDs', () => {
    const cycle = []; cycle.push(cycle);
    const data = sanitize({ apiKey: 'private', prompt: 'private prompt', taskId: 'task-123',
        message: 'Bearer abcdef sk-secret https://user:pass@host.test/tasks/123?token=hidden#private custom-secret',
        filePath: '/Users/private/image.png', cycle }, ['custom-secret']);
    const text = JSON.stringify(data);
    for (const secret of ['private prompt', 'abcdef', 'sk-secret', 'user:pass', 'hidden', 'custom-secret', '/Users/private']) assert.equal(text.includes(secret), false);
    assert.equal(data.taskId, 'task-123');
    assert.match(text, /Circular/);
});
test('errors retain stacks, logs persist after restart, and query remains bounded', t => {
    const { log, dir } = setup(t);
    log.record('error', 'fixture', { error: new Error('fixture failure'), requestId: 'req-1' });
    log.flush();
    const restored = new DiagnosticLog(dir);
    const entries = restored.read();
    assert.equal(entries.length, 1);
    assert.match(entries[0].data.error.stack, /fixture failure/);
    assert.equal(entries[0].data.requestId, 'req-1');
    assert.notEqual(restored.sessionId, entries[0].sessionId);
});
test('rotation bounds disk use and retains newest entries', t => {
    const { log, dir } = setup(t, { maxBytes: 800, files: 3 });
    for (let i = 0; i < 50; i++) log.record('info', 'fixture', { index: i });
    const entries = log.read();
    assert.equal(entries.at(-1).data.index, 49);
    assert.ok(fs.readdirSync(dir).length <= 3);
    assert.ok(fs.readdirSync(dir).every(file => fs.statSync(path.join(dir, file)).size <= 800));
});
test('logging tolerates write errors and recursive secret-provider errors', t => {
    const { log, dir } = setup(t);
    const file = path.join(dir, 'not-a-directory'); fs.writeFileSync(file, 'fixture');
    log.directory = file;
    log.getSecrets = () => { log.record('warn', 'recursive'); return []; };
    log.record('error', 'fixture'); log.flush();
    assert.ok(log.dropped > 0);
    assert.ok(log.writeError);
});
test('burst and oversized records cannot grow the pending queue without bound', t => {
    const { log } = setup(t);
    log.record('info', 'large', { values: Array(100).fill('x'.repeat(6000)) });
    for (let i = 0; i < 1200; i++) log.record('info', 'burst');
    assert.equal(log.pending.length, 1000);
    assert.equal(log.dropped, 201);
    assert.ok(log.pending.every(line => Buffer.byteLength(line) <= 32768));
});
