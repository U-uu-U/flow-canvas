import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AgentRuntimeClient, isRuntimeTerminal, mergeRuntimeSnapshot, runtimeActions,
    runtimeOutputFiles, runtimePriceText, runtimeScopeKey, settleRuntimeConversation, runtimeDisplayText, runtimeDisplayPlan,
    runtimeTaskTitle, runtimeEstimateText, runtimeProgressText, runtimeStepSources
} from './agent-runtime-view.js';

const snapshot = (patch = {}) => ({
    id: 'run-1', projectId: 'project-1', conversationId: 'chat-1',
    status: 'planning', outputText: '', events: [], lastSeq: 0, ...patch
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('status controls expose one plan confirmation and recovery', () => {
    assert.deepEqual(runtimeActions(snapshot({ status: 'awaiting_confirmation', plan: { version: 3 } })), ['confirm', 'revise', 'cancel']);
    for (const status of ['planning', 'running', 'waiting_provider', 'reviewing']) {
        assert.equal(isRuntimeTerminal(status), false);
        assert.deepEqual(runtimeActions(snapshot({ status })), ['cancel']);
    }
    for (const status of ['partial_failed', 'failed', 'interrupted']) {
        assert.equal(isRuntimeTerminal(status), true);
        assert.deepEqual(runtimeActions(snapshot({ status })), status === 'interrupted' ? ['resume'] : ['resume', 'retry']);
    }
    for (const status of ['completed', 'canceled']) assert.deepEqual(runtimeActions(snapshot({ status })), []);
});

test('snapshot merge rejects stale and cross-conversation data; events are deduplicated', () => {
    const previous = snapshot({ outputText: 'ab', lastSeq: 2, events: [{ seq: 1, type: 'text_delta' }, { seq: 2, type: 'assistant' }] });
    assert.equal(mergeRuntimeSnapshot(previous, snapshot({ lastSeq: 1 })), previous);
    assert.equal(mergeRuntimeSnapshot(previous, snapshot({ conversationId: 'other', lastSeq: 9 })), previous);
    const next = mergeRuntimeSnapshot(previous, snapshot({
        outputText: 'abc', lastSeq: 3, events: [{ seq: 2, type: 'assistant' }, { seq: 3, type: 'status' }]
    }));
    assert.equal(next.outputText, 'abc');
    assert.deepEqual(next.events.map(event => event.seq), [1, 2, 3]);
    assert.notEqual(runtimeScopeKey(null, 'chat-1'), runtimeScopeKey('__no_project__', 'chat-1'));
});

test('settlement is atomic, idempotent, keeps metadata and updates one message on resume', () => {
    const conversation = {
        id: 'chat-1', customTitle: true, title: 'custom', files: [{ id: 'input' }],
        messages: [{ role: 'user', content: 'hello', metadata: { keep: true } }]
    };
    const completed = snapshot({ status: 'completed', lastSeq: 4, outputText: 'answer' });
    const saved = settleRuntimeConversation(conversation, completed);
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.messages[1].runtimeRunId, completed.id);
    assert.deepEqual(saved.files, conversation.files);
    assert.deepEqual(saved.messages[0].metadata, { keep: true });
    assert.equal(saved.title, 'custom');
    assert.equal(settleRuntimeConversation(saved, completed), saved);
    const reloaded = JSON.parse(JSON.stringify(saved));
    assert.equal(settleRuntimeConversation(reloaded, completed), reloaded);
    const resumed = settleRuntimeConversation(saved, { ...completed, outputText: 'updated', lastSeq: 9 });
    assert.equal(resumed.messages.length, 2);
    assert.equal(resumed.messages[1].content, 'updated');
    assert.equal(settleRuntimeConversation({ ...conversation, id: 'other' }, completed).messages.length, 1);
    assert.equal(settleRuntimeConversation(null, completed), null);
});

test('trimmed or explicitly cleared replies do not reappear after rehydration', () => {
    const run = snapshot({ status: 'completed', outputText: 'answer', lastSeq: 5 });
    const trimmed = { id: 'chat-1', messages: [], runtimeReceipts: { 'run-1': { seq: 3, hasMessage: true } } };
    assert.equal(settleRuntimeConversation(trimmed, run).messages.length, 0);
    const cleared = { ...trimmed, runtimeReceipts: { 'run-1': { ignored: true } } };
    assert.equal(settleRuntimeConversation(cleared, run), cleared);
});

test('partial output is saved on interruption but not while running', () => {
    const conversation = { id: 'chat-1', messages: [] };
    assert.equal(settleRuntimeConversation(conversation, snapshot({ status: 'running', outputText: 'partial' })), conversation);
    assert.equal(settleRuntimeConversation(conversation, snapshot({
        status: 'interrupted', outputText: 'partial', lastSeq: 5
    })).messages[0].content, 'partial');
});

test('only explicit sourced sale prices are displayed, never upstream cost', () => {
    assert.equal(runtimePriceText({ amount: 1.5, currency: 'CNY', unit: 'request', kind: 'cost', source: 'upstream' }), '');
    assert.equal(runtimePriceText({ amount: 6, currency: 'CNY', unit: 'request' }), '');
    assert.equal(runtimePriceText({ amount: 6, currency: 'CNY', unit: 'request', kind: 'sale', source: 'configured' }), 'CNY 6/次');
});

test('outputs use only tool results and deduplicate file paths', () => {
    const run = snapshot({ events: [
        { type: 'plan', data: { filePath: '/not-an-output.png' } },
        { type: 'tool_result', data: { result: { filePaths: ['/a.png'], files: [{ filePath: '/b.mp4', nodeId: 'node-2' }] } } },
        { type: 'tool_result', data: { filePath: '/a.png' } }
    ] });
    assert.equal(runtimeOutputFiles(run).length, 2);
    assert.equal(runtimeOutputFiles(run).find(file => file.filePath === '/b.mp4').sourceNodeId, 'node-2');
});

test('batch tool result files survive nested results on rehydration', () => {
    assert.deepEqual(runtimeOutputFiles(snapshot({ events: [{
        type: 'tool_result', data: { result: { results: [{ filePaths: ['/a.png'], nodeIds: ['node-1'] }] } }
    }] })), [{ filePath: '/a.png', mediaType: 'image', sourceNodeId: 'node-1' }]);
});

test('stream text is shown before assistant completion without duplicating accumulated output', () => {
    const run = snapshot({ events: [
        { seq: 1, type: 'text_delta', data: { text: 'hel' } },
        { seq: 2, type: 'text_delta', data: { text: 'lo' } }
    ] });
    assert.equal(runtimeDisplayText(run), 'hello');
    assert.equal(runtimeDisplayText({ ...run, outputText: 'hello' }), 'hello');
    assert.equal(runtimeDisplayText({ ...run, status: 'completed', outputText: 'final' }), 'final');
    assert.equal(runtimeDisplayText({ ...run, outputText: 'hello', events: [
        ...run.events, { seq: 3, type: 'assistant', data: { text: 'hello' } },
        { seq: 4, type: 'text_delta', data: { text: 'next' } }
    ] }), 'hello\n\nnext');
});

test('completed plans rehydrate from plan events without re-enabling confirmation', () => {
    const plan = { version: 'opaque-version', kind: 'memory', steps: [], proposed: { language: 'zh' } };
    const run = snapshot({ status: 'completed', plan: null, events: [{ seq: 2, type: 'plan', data: plan }] });
    assert.deepEqual(runtimeDisplayPlan(run), plan);
    assert.deepEqual(runtimeActions(run), []);
    assert.equal(runtimeDisplayPlan({ ...run, status: 'planning' }), null);
});

test('push invalidations use authoritative get to repair skipped and out-of-order events', async () => {
    let listener;
    let unsubscribed = 0;
    const calls = [];
    const client = new AgentRuntimeClient({
        onEvent(callback) { listener = callback; return () => { unsubscribed++; }; },
        async get(args) {
            calls.push(args);
            return snapshot({ lastSeq: 10, outputText: 'full answer', status: 'completed', events: [{ seq: 10, type: 'status' }] });
        },
        async list() { return []; }
    });
    client.accept(snapshot({ lastSeq: 2 }));
    client.connect();
    listener({ runId: 'run-1', seq: 9, type: 'text_delta', data: { text: 'tail' } });
    await tick();
    assert.deepEqual(calls[0], { runId: 'run-1', afterSeq: 0 });
    assert.equal(client.runs.get('run-1').outputText, 'full answer');
    listener({ runId: 'run-1', seq: 3 });
    await tick();
    assert.equal(calls[1].afterSeq, 10);
    client.dispose();
    assert.equal(unsubscribed, 1);
    assert.equal(client.timer, null);
});

test('background list completion cannot contaminate another scope', async () => {
    const resolvers = new Map();
    const changed = [];
    const client = new AgentRuntimeClient({
        list: scope => new Promise(resolve => resolvers.set(scope.conversationId, resolve))
    }, { onChange: run => changed.push(run.conversationId) });
    const first = client.watch({ projectId: 'project-1', conversationId: 'chat-1' });
    const second = client.watch({ projectId: 'project-2', conversationId: 'chat-2' });
    resolvers.get('chat-2')([snapshot({ id: 'run-2', projectId: 'project-2', conversationId: 'chat-2' })]);
    await second;
    resolvers.get('chat-1')([snapshot(), snapshot({ id: 'wrong', conversationId: 'wrong' })]);
    await first;
    assert.deepEqual(changed, ['chat-2', 'chat-1']);
    assert.equal(client.runs.size, 2);
    client.dispose();
});

test('list snapshots never advance the event cursor; late event pages keep newer status', async () => {
    const calls = [];
    let finishGet;
    const client = new AgentRuntimeClient({
        list: async () => [snapshot({ lastSeq: 10, status: 'completed', outputText: 'final' })],
        get: args => { calls.push(args); return new Promise(resolve => { finishGet = resolve; }); }
    });
    await client.watch({ projectId: 'project-1', conversationId: 'chat-1' });
    assert.deepEqual(calls, [{ runId: 'run-1', afterSeq: 0 }]);
    finishGet(snapshot({ lastSeq: 8, status: 'running', events: [
        { seq: 7, type: 'tool_result', data: { filePath: '/output.png' } }
    ] }));
    await tick();
    assert.equal(client.runs.get('run-1').status, 'completed');
    assert.equal(client.runs.get('run-1').outputText, 'final');
    assert.equal(runtimeOutputFiles(client.runs.get('run-1')).length, 1);
    client.dispose();
});

test('confirm locks one run/version, cancel targets its run, revise trims feedback', async () => {
    const calls = [];
    let confirmDone;
    const awaiting = snapshot({ status: 'awaiting_confirmation', plan: { version: 7 }, lastSeq: 3 });
    const client = new AgentRuntimeClient({
        confirm: args => { calls.push(['confirm', args]); return new Promise(resolve => { confirmDone = resolve; }); },
        cancel: async args => { calls.push(['cancel', args]); },
        revise: async args => { calls.push(['revise', args]); },
        resume: async args => { calls.push(['resume', args]); },
        get: async ({ runId }) => runId === 'run-1' ? awaiting : snapshot({ id: runId })
    });
    client.accept(awaiting);
    client.accept(snapshot({ id: 'run-2' }));
    const first = client.act('run-1', 'confirm');
    await client.act('run-1', 'confirm');
    await client.act('run-2', 'cancel');
    confirmDone();
    await first;
    await client.act('run-1', 'confirm');
    await client.act('run-1', 'revise', '  feedback  ');
    client.accept(snapshot({ status: 'interrupted', lastSeq: 4 }));
    await client.act('run-1', 'resume');
    assert.deepEqual(calls, [
        ['confirm', { runId: 'run-1', planVersion: 7 }],
        ['cancel', { runId: 'run-2' }],
        ['revise', { runId: 'run-1', instruction: 'feedback' }],
        ['resume', { runId: 'run-1' }]
    ]);
    client.dispose();
});

test('missing subscription uses polling and disposal stops late results', async () => {
    let resolveList;
    const client = new AgentRuntimeClient({ list: () => new Promise(resolve => { resolveList = resolve; }) });
    client.connect();
    assert.ok(client.timer);
    const pending = client.watch({ projectId: 'project-1', conversationId: 'chat-1' });
    client.dispose();
    resolveList([snapshot()]);
    await pending;
    assert.equal(client.runs.size, 0);
});

test('retry failed items is a separate request and never automatically confirms its new plan', async () => {
    const calls = [];
    const pending = snapshot({ status: 'awaiting_confirmation', lastSeq: 8,
        plan: { kind: 'generation', version: 'retry-version', steps: [] } });
    let completeRetry;
    const client = new AgentRuntimeClient({
        retry: args => { calls.push(['retry', args]); return new Promise(resolve => { completeRetry = resolve; }); },
        resume: async args => { calls.push(['resume', args]); },
        confirm: async args => { calls.push(['confirm', args]); },
        get: async () => pending
    });
    client.accept(snapshot({ status: 'partial_failed', lastSeq: 7 }));
    const retry = client.act('run-1', 'retry');
    await client.act('run-1', 'retry');
    completeRetry(pending);
    await retry;
    assert.deepEqual(calls, [['retry', { runId: 'run-1' }]]);
    assert.deepEqual(runtimeActions(client.runs.get('run-1')), ['confirm', 'revise', 'cancel']);
    client.dispose();
});

test('static snapshots restore and deduplicate outputs without event history', () => {
    const results = [{ nodeIds: ['output-node'], filePaths: ['C:/outputs/result.png'] }];
    const run = snapshot({ status: 'completed', results, review: 'checked', events: [] });
    assert.equal(runtimeOutputFiles(run)[0].filePath, 'C:/outputs/result.png');
    assert.equal(runtimeOutputFiles(run)[0].sourceNodeId, 'output-node');
    assert.equal(runtimeOutputFiles({ ...run, events: [
        { type: 'tool_result', data: { result: results[0] } }
    ] }).length, 1);
});

test('titles describe the pending operation, while progress resolves titles instead of step IDs', () => {
    const run = snapshot({ status: 'awaiting_confirmation', plan: { kind: 'memory', version: 'uuid', steps: [] } });
    assert.equal(runtimeTaskTitle(run), '待确认：保存项目记忆');
    assert.equal(runtimeTaskTitle({ ...run, plan: { kind: 'board' } }), '待确认：修改画板');
    assert.equal(runtimeTaskTitle({ ...run, plan: { kind: 'generation', steps: [{ kind: 'video' }] } }), '待确认：生成视频');
    const progress = snapshot({ plan: { steps: [{ id: 'step-uuid', title: 'Product main view' }] },
        events: [{ type: 'step', data: { stepId: 'step-uuid', status: 'completed' } }] });
    assert.equal(runtimeProgressText(progress), '步骤已完成 · Product main view');
    assert.equal(runtimeProgressText({ ...progress, plan: null }), '步骤已完成');
    assert.equal(runtimeProgressText({ ...progress, plan: null, steps: [{ id: 'step-uuid', title: 'Saved title' }] }), '步骤已完成 · Saved title');
});

test('unknown or upstream-cost pricing never displays an invented zero total', () => {
    const plan = { kind: 'generation', priceKnown: false, estimatedCost: 0, currency: 'CNY', steps: [{ price: null }] };
    assert.equal(runtimeEstimateText(plan), '预计费用：未知');
    assert.equal(runtimeEstimateText({ ...plan, priceKnown: true }), '预计费用：未知');
    const price = { kind: 'sale', amount: 6, currency: 'CNY', source: 'configured', unit: 'request' };
    assert.equal(runtimeEstimateText({ ...plan, priceKnown: true, estimatedCost: 6, steps: [{ price }] }), '预计费用：CNY 6');
    assert.equal(runtimeEstimateText({ ...plan, priceKnown: true, steps: [{ price: { ...price, kind: 'cost' } }] }), '预计费用：未知');
    assert.equal(runtimeEstimateText({ ...plan, kind: 'memory' }), '');
});

test('source labels show ordered filenames instead of technical node IDs', () => {
    assert.deepEqual(runtimeStepSources({ references: [
        { filePath: 'C:\\assets\\front.png', nodeId: 'technical-node' },
        { name: 'Side reference', filePath: '/assets/side.png' },
        { nodeId: 'not-yet-generated' }
    ] }), [
        { name: 'front.png', path: 'C:\\assets\\front.png' },
        { name: 'Side reference', path: '/assets/side.png' },
        { name: '参考素材 3', path: '' }
    ]);
});
