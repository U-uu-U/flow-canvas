const test = require('node:test');
const assert = require('node:assert/strict');
const { imageRequestFailure } = require('./image-request-diagnostics.cjs');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function imageRequest(fetch, timers = {}) {
    const file = path.join(__dirname, 'mcp-bridge.js');
    const wrapper = vm.runInNewContext(`(function(require, module) { ${fs.readFileSync(file, 'utf8')}\nreturn tryGenerateWithOpenAI; })`, {
        Buffer, URL, AbortController, console, process: { env: {} }, setTimeout, clearTimeout, ...timers
    });
    return wrapper(name => name === 'electron' ? { net: { fetch } } : require(name), { exports: {} });
}
const options = { requestId: 'fixture-request', providerConfig: { apiKey: 'fixture-secret', endpoint: 'https://fixture.test', model: 'gpt-image-2' } };

test('empty response reports correlation, timing and payload without claiming server rejection', () => {
    const error = imageRequestFailure(new Error('net::ERR_EMPTY_RESPONSE'), {
        requestId: 'test-request', startedAt: 1000, now: 66000, payloadBytes: 1572864, imageCount: 2, phase: '等待响应'
    });
    assert.match(error.message, /test-request/);
    assert.match(error.message, /65 秒/);
    assert.match(error.message, /1.50 MB/);
    assert.match(error.message, /不能据此认定生成失败/);
});

test('body timeout is distinguished from user cancellation and includes uncertain submission guidance', () => {
    const error = imageRequestFailure(new Error('aborted'), {
        requestId: 'body-request', startedAt: 1000, now: 301000, payloadBytes: 0, imageCount: 0,
        phase: '读取结果', timedOut: true
    });
    assert.match(error.message, /完整响应超过 300 秒/);
    assert.match(error.message, /读取结果/);
    assert.match(error.message, /不要连续重复生成/);
});

test('unknown submission outcome carries a structured marker, not just prose', () => {
    // 渲染层据 submissionUnknown 把任务归为「结果未知/待重传」，而不是
    // 「确定失败」——后者会给出「重新提交会创建新任务」的建议，
    // 与本条消息末尾的告诫矛盾，且可能重复计费。
    const timeout = imageRequestFailure(new Error('aborted'), {
        requestId: 'r1', startedAt: 0, now: 301000, payloadBytes: 0, imageCount: 1,
        phase: '读取结果', timedOut: true
    });
    assert.equal(timeout.submissionUnknown, true);
    assert.equal(timeout.timedOut, true);

    const emptyResponse = imageRequestFailure(new Error('net::ERR_EMPTY_RESPONSE'), {
        requestId: 'r2', startedAt: 0, now: 5000, payloadBytes: 0, imageCount: 1, phase: '等待响应'
    });
    assert.equal(emptyResponse.submissionUnknown, true);
    assert.equal(emptyResponse.timedOut, false);
});

test('empty POST response is not resubmitted and diagnostic excludes credentials', async () => {
    let calls = 0;
    const run = imageRequest(async () => { calls++; throw new Error('net::ERR_EMPTY_RESPONSE'); });
    const result = await run('fixture prompt', '.', options);
    assert.equal(result.success, false);
    assert.equal(calls, 1);
    assert.match(result.error, /fixture-request/);
    assert.equal(result.error.includes('fixture-secret'), false);
    assert.equal(result.error.includes('fixture prompt'), false);
});

test('deadline stays active during response body and Location task ID survives interruption', async () => {
    let expire, calls = 0, cleaned = false;
    const submitted = [];
    const run = imageRequest(async (_url, request) => {
        calls++;
        return { ok: true, status: 202, headers: new Headers({ location: '/v1/tasks/task_test_123456' }),
            text: () => new Promise((_resolve, reject) => {
                assert.equal(cleaned, false);
                request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                expire();
            }) };
    }, { setTimeout: callback => { expire = callback; return 1; }, clearTimeout: () => { cleaned = true; } });
    const result = await run('fixture prompt', '.', { ...options, onTaskSubmitted: event => submitted.push(event) });
    assert.equal(calls, 1);
    assert.equal(cleaned, true);
    assert.equal(submitted[0].taskId, 'task_test_123456');
    assert.match(result.error, /完整响应超过 300 秒/);
    assert.match(result.error, /读取结果/);
});
