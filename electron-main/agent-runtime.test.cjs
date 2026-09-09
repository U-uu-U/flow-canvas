'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentRuntime } = require('./agent-runtime.cjs');
const { AgentRunStore } = require('./agent-run-store.cjs');

const provider = { id: 'text-provider', type: 'openai', endpoint: 'https://relay.example/v1',
    model: 'mock-model', apiKey: 'sk-runtime-fixture-secret-123456' };
const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } };
const tool = (id, name, args = {}) => ({ id, name: `flow_canvas.${name}`, arguments: args });
const reply = (text = 'Finished', toolCalls = [], extra = {}) => ({ text, toolCalls, usage: {}, toolSupport: 'supported', ...extra });
const graphCall = (id = 'generate') => tool(id, 'graph.run', { nodeIds: ['image-1'], summary: 'Generate one image' });
const toolResults = request => request.messages.filter(message => message.role === 'tool')
    .map(message => ({ id: message.tool_call_id, value: JSON.parse(message.content) }));

test('retry excludes completed calls and requires a fresh plan confirmation', async t => {
    const saved = recoveryRun({}, { status: 'partial_failed', steps: [
        { id: 'done', status: 'completed', result: { nodeIds: ['done'] } },
        { id: 'bad', status: 'failed', prompt: 'retry' },
        { id: 'remaining', status: 'queued', prompt: 'continue' }
    ], results: [{ stepId: 'done', nodeIds: ['done'] }] });
    const h = harness(t, { initialRuns: [saved] });
    const proposed = h.runtime.retry({ runId: saved.id, projectId: 'a' });
    assert.equal(proposed.status, 'awaiting_confirmation');
    assert.equal(proposed.plan.steps.length, 2);
    assert.notEqual(proposed.plan.version, saved.plan.version);
    assert.ok(proposed.plan.steps.every(step => !['done', 'bad', 'remaining'].includes(step.id)));
    assert.equal(h.stepCalls.length, 0);
    assert.equal(proposed.results.length, 1);
});

test('retry refuses ambiguous submissions and wrong projects', async t => {
    const saved = recoveryRun({ status: 'unknown', remoteTaskId: null }, { status: 'failed' });
    const h = harness(t, { initialRuns: [saved] });
    assert.throws(() => h.runtime.retry({ runId: saved.id, projectId: 'b' }), { code: 'PROJECT_MISMATCH' });
    assert.throws(() => h.runtime.retry({ runId: saved.id }), { code: 'SUBMISSION_UNKNOWN' });
    assert.equal(h.stepCalls.length, 0);
});

test('external graph proposals confirm and run without invoking an internal language model', async t => {
    const h = harness(t, { script: [] });
    const proposal = await h.runtime.propose({ projectId: 'a', toolName: 'flow_canvas.graph.run',
        input: { nodeIds: ['image-1'], summary: 'External batch' } });
    assert.equal(proposal.external, true);
    assert.equal(proposal.status, 'awaiting_confirmation');
    assert.equal(h.stepCalls.length, 0);
    h.runtime.confirm({ runId: proposal.id, planVersion: proposal.plan.version });
    const result = await h.idle(proposal.id);
    assert.equal(result.status, 'completed');
    assert.equal(h.requests.length, 0);
    assert.equal(h.stepCalls.length, 1);
});

async function until(predicate, label = 'condition') {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}

function harness(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-agent-runtime-test-'));
    const runStore = new AgentRunStore(directory);
    for (const run of options.initialRuns || []) runStore.save(run);
    const projects = new Map(['a', 'b', null].map(id => [id, { id, items: [], agentMemory: { brief: `Project ${id}` } }]));
    const h = { directory, runStore, projects, events: [], requests: [], boardCalls: [], stepCalls: [], mediaCalls: [],
        providerBindings: [], releases: [], script: [...(options.script || [reply()])] };
    h.gate = (fallback = reply()) => {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        h.releases.push(() => resolve(fallback));
        return { promise, resolve };
    };
    const defaults = {
        readProject(projectId) {
            if (!projects.has(projectId)) throw Object.assign(new Error('Project unavailable'), { code: 'PROJECT_NOT_FOUND' });
            return projects.get(projectId);
        },
        snapshot: projectId => ({ projectId, items: [{ id: `${projectId}-node` }], connections: [] }),
        preview: projectId => ({ projectId, valid: true }),
        apply: projectId => ({ projectId, applied: true, undoToken: 'undo-1' }),
        undo: (projectId, undoToken) => ({ projectId, undoToken, undone: true }),
        updateProject(projectId, update) { update(projects.get(projectId)); return projects.get(projectId); }
    };
    const board = Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => [name, (...args) => {
        h.boardCalls.push({ name, args });
        return (options.board?.[name] || fallback)(...args);
    }]));
    h.runtime = new AgentRuntime({
        runStore, board,
        boardDefinitions: ['get_snapshot', 'transaction.preview', 'transaction.apply', 'transaction.undo'].map(name => ({
            name: `flow_canvas.board.${name}`, description: name, inputSchema: { type: 'object' }
        })),
        resolveProvider: (binding, kind) => { h.providerBindings.push({ binding, kind }); return options.provider || provider; },
        callProvider: async request => {
            h.requests.push({ ...request, messages: structuredClone(request.messages), tools: structuredClone(request.tools) });
            if (!h.script.length) throw new Error('Unexpected provider call: mock script exhausted');
            const next = h.script.shift();
            return typeof next === 'function' ? next(request, h) : next;
        },
        listModels: options.listModels || (() => [{ id: 'image-model', parameters: { sizes: ['1024x1024'] } }]),
        readMedia: async (...args) => {
            h.mediaCalls.push(args);
            return options.readMedia ? options.readMedia(...args) : { images: [image], evidence: { nodeId: args[1].nodeId, observed: true } };
        },
        prepareGraph: options.prepareGraph || (async (run, input) => ({ summary: input.summary,
            steps: input.nodeIds.map(id => ({ id: `step-${id}`, nodeId: id, title: id, prompt: 'Render requested image', references: [] })) })),
        executeStep: async (step, run, context) => {
            h.stepCalls.push({ step: structuredClone(step), runId: run.id, projectId: run.projectId, context });
            return options.executeStep ? options.executeStep(step, run, context) : { nodeIds: [`output-${step.id}`], saved: true };
        },
        onEvent: event => h.events.push(structuredClone(event)),
        maxTurns: options.maxTurns || 20
    });
    h.start = (extra = {}) => h.runtime.start({ projectId: 'a', conversationId: 'conversation-1',
        messages: [{ role: 'user', content: 'Create the requested work' }], ...extra }).id;
    h.idle = async id => {
        await until(() => !h.runtime.controllers.has(id), `run ${id} to settle`);
        return h.runtime.get({ runId: id });
    };
    h.disk = id => JSON.parse(fs.readFileSync(path.join(directory, `${id}.json`), 'utf8'));
    h.confirm = id => h.runtime.confirm({ runId: id, planVersion: h.runtime.get({ runId: id }).plan.version });
    t.after(async () => {
        for (const runId of h.runtime.controllers.keys()) h.runtime.cancel({ runId });
        h.releases.forEach(release => release());
        await until(() => !h.runtime.controllers.size, 'mock operations to stop');
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return h;
}

function recoveryRun(stepOverrides = {}, overrides = {}) {
    const call = graphCall();
    return {
        id: 'agent-recovery', projectId: 'a', conversationId: 'recovered-conversation', status: 'waiting_provider',
        outputText: '', createdAt: 1, updatedAt: 1, lastSeq: 0, events: [], turns: 1, results: [], attachments: [],
        source: null, mode: 'auto', skillInstructions: [], providerRef: { id: provider.id, model: provider.model },
        messages: [{ role: 'user', content: 'Create the requested work' }, { role: 'assistant', content: '',
            tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }],
        pendingCalls: [call], plan: { kind: 'generation', approved: true, version: 'approved-version',
            steps: [{ id: 'step-image-1', title: 'Image', prompt: 'Render', references: [] }] },
        steps: [{ id: 'step-image-1', nodeId: 'image-1', status: 'submitted', remoteTaskId: 'remote-existing', ...stepOverrides }],
        ...overrides
    };
}

test('text-only task streams text, reports usage, persists completion and releases its provider session', async t => {
    const first = 'Hello '.repeat(20);
    const second = 'world'.repeat(24);
    const h = harness(t, { script: [request => {
        request.onDelta(first);
        request.onDelta(second);
        return reply(first + second, [], { usage: { input_tokens: 4, output_tokens: 2 } });
    }] });
    const id = h.start();
    const result = await h.idle(id);
    assert.equal(result.status, 'completed');
    assert.equal(result.outputText, first + second);
    assert.equal(h.events.filter(event => event.type === 'text_delta').map(event => event.data.text).join(''), first + second);
    assert.deepEqual(h.events.find(event => event.type === 'usage').data, { input_tokens: 4, output_tokens: 2 });
    assert.equal(h.disk(id).status, 'completed');
    assert.equal(h.runtime.providerSessions.has(id), false);
    assert.equal(result.messages, undefined);
    assert.equal(result.providerRef, undefined);
    assert.equal(h.requests[0].provider.apiKey, provider.apiKey);
    assert.ok(h.requests[0].tools.some(entry => entry.function.name === 'flow_canvas.graph.run'));
});

test('tool loop preserves parallel call IDs, tool outputs and real model parameters in the next turn', async t => {
    const h = harness(t, { script: [reply('', [tool('memory', 'memory.read'), tool('models', 'model.list'), tool('board', 'board.get_snapshot')]), reply()] });
    const id = h.start();
    assert.equal((await h.idle(id)).status, 'completed');
    const results = toolResults(h.requests[1]);
    assert.deepEqual(results.map(result => result.id), ['memory', 'models', 'board']);
    assert.equal(results[0].value.brief, 'Project a');
    assert.deepEqual(results[1].value[0].parameters.sizes, ['1024x1024']);
    assert.equal(results[2].value.projectId, 'a');
    assert.equal(h.disk(id).pendingCalls.length, 0);
});

test('one failed tool yields a structured result while the remaining tools and next turn still run', async t => {
    const h = harness(t, { listModels: () => { throw Object.assign(new Error('Catalog offline'), { code: 'CATALOG_OFFLINE' }); },
        script: [reply('', [tool('models', 'model.list'), tool('memory', 'memory.read')]), reply('Catalog failed; memory was read')] });
    assert.equal((await h.idle(h.start())).status, 'completed');
    const results = toolResults(h.requests[1]);
    assert.deepEqual(results[0].value.error, { code: 'CATALOG_OFFLINE', message: 'Catalog offline' });
    assert.equal(results[1].value.brief, 'Project a');
});

test('unrecognized tools return TOOL_NOT_FOUND instead of being dispatched to the board', async t => {
    const h = harness(t, { script: [reply('', [tool('unknown', 'system.shell', { command: 'must-not-execute' })]), reply()] });
    await h.idle(h.start());
    assert.equal(toolResults(h.requests[1])[0].value.error.code, 'TOOL_NOT_FOUND');
    assert.deepEqual(h.boardCalls.map(call => call.name), ['readProject']);
});

test('task remains bound to its starting project after an active-project switch and tool-supplied project ID', async t => {
    let activeProject = 'a';
    const h = harness(t, { script: [() => {
        activeProject = 'b';
        return reply('', [tool('snapshot', 'board.get_snapshot', { projectId: activeProject }),
            tool('apply', 'board.transaction.apply', { reason: 'Create text', operations: [] }),
            tool('undo', 'board.transaction.undo', { undoToken: 'undo-1' })]);
    }, reply()] });
    const id = h.start({ attachments: [{ sourceNodeId: 'a-reference' }] });
    const run = await h.idle(id);
    assert.equal(activeProject, 'b');
    assert.equal(run.projectId, 'a');
    h.boardCalls.forEach(call => assert.equal(call.args[0], 'a'));
    assert.deepEqual(h.boardCalls.find(call => call.name === 'snapshot').args[1].selectedItemIds, ['a-reference']);
    assert.ok(h.events.every(event => event.projectId === 'a'));
});

test('a removed project is rejected before a task, provider call or disk record is created', t => {
    const h = harness(t);
    assert.throws(() => h.start({ projectId: 'removed' }), { code: 'PROJECT_NOT_FOUND' });
    assert.equal(h.runtime.runs.size, 0);
    assert.equal(h.requests.length, 0);
    assert.deepEqual(fs.readdirSync(h.directory), []);
});

test('ask-mode board plan previews first and applies exactly once after confirmation', async t => {
    const h = harness(t, { script: [reply('', [tool('apply', 'board.transaction.apply', { reason: 'Add a node', operations: [] })]), reply()] });
    const id = h.start({ mode: 'ask' });
    const pending = await h.idle(id);
    assert.equal(pending.status, 'awaiting_confirmation');
    assert.equal(pending.plan.kind, 'board');
    assert.equal(h.boardCalls.filter(call => call.name === 'preview').length, 1);
    assert.equal(h.boardCalls.filter(call => call.name === 'apply').length, 0);
    h.confirm(id);
    assert.equal((await h.idle(id)).status, 'completed');
    assert.equal(h.boardCalls.filter(call => call.name === 'apply').length, 1);
    assert.equal(toolResults(h.requests[1])[0].id, 'apply');
});

test('a two-step paid batch requires one confirmation and pairs the completed graph result before continuing', async t => {
    const h = harness(t, { script: [reply('', [tool('batch', 'graph.run', { nodeIds: ['one', 'two'], summary: 'Two images' })]),
        reply('Visual review'), reply('Both saved')] });
    const id = h.start();
    const pending = await h.idle(id);
    assert.equal(pending.status, 'awaiting_confirmation');
    assert.equal(h.stepCalls.length, 0);
    assert.equal(h.disk(id).pendingCalls[0].id, 'batch');
    h.confirm(id);
    const done = await h.idle(id);
    assert.equal(done.status, 'completed');
    assert.equal(done.results.length, 2);
    assert.deepEqual(h.stepCalls.map(call => call.step.id), ['step-one', 'step-two']);
    assert.equal(h.events.filter(event => event.type === 'plan').length, 1);
    assert.equal(h.requests[1].tools.length, 0);
    assert.equal(toolResults(h.requests[2])[0].id, 'batch');
    assert.equal(toolResults(h.requests[2])[0].value.completed, true);
});

test('stale plan confirmation cannot execute a generation', async t => {
    const h = harness(t, { script: [reply('', [graphCall()])] });
    const id = h.start();
    await h.idle(id);
    assert.throws(() => h.runtime.confirm({ runId: id, planVersion: 'stale' }), { code: 'PLAN_CHANGED' });
    assert.equal(h.runtime.get({ runId: id }).status, 'awaiting_confirmation');
    assert.equal(h.stepCalls.length, 0);
});

test('double confirmation during execution and after completion never submits a step twice', async t => {
    let gate;
    const h = harness(t, { script: [reply('', [graphCall()]), reply('Review'), reply()], executeStep: () => gate.promise });
    gate = h.gate({ nodeIds: ['saved-node'] });
    const id = h.start();
    const version = (await h.idle(id)).plan.version;
    h.runtime.confirm({ runId: id, planVersion: version });
    assert.throws(() => h.runtime.confirm({ runId: id, planVersion: version }), { code: 'PLAN_CHANGED' });
    await until(() => h.stepCalls.length === 1);
    gate.resolve({ nodeIds: ['saved-node'] });
    await h.idle(id);
    assert.throws(() => h.runtime.confirm({ runId: id, planVersion: version }), { code: 'PLAN_CHANGED' });
    assert.equal(h.stepCalls.length, 1);
});

test('revise resolves every pending call with cancellation before asking for a replacement plan', async t => {
    const h = harness(t, { script: [reply('', [graphCall('old-plan'), tool('queued-models', 'model.list')]),
        reply('', [graphCall('new-plan')])] });
    const id = h.start();
    const old = await h.idle(id);
    h.runtime.revise({ runId: id, instruction: 'Use the second reference instead' });
    const revised = await h.idle(id);
    assert.equal(revised.status, 'awaiting_confirmation');
    assert.notEqual(revised.plan.version, old.plan.version);
    const results = toolResults(h.requests[1]);
    assert.deepEqual(results.map(result => result.id), ['old-plan', 'queued-models']);
    assert.ok(results.every(result => result.value.canceled));
    assert.equal(h.requests[1].messages.at(-1).content, 'Use the second reference instead');
    assert.equal(h.stepCalls.length, 0);
    assert.deepEqual(h.disk(id).pendingCalls.map(call => call.id), ['new-plan']);
    assert.throws(() => h.runtime.confirm({ runId: id, planVersion: old.plan.version }), { code: 'PLAN_CHANGED' });
});

test('memory proposals do not become confirmed project facts until the user confirms', async t => {
    const h = harness(t, { script: [reply('', [tool('remember', 'memory.propose', { brief: 'Confirmed brief', constraints: ['Keep red'] })]), reply()] });
    const id = h.start();
    await h.idle(id);
    assert.equal(h.projects.get('a').agentMemory.brief, 'Project a');
    h.confirm(id);
    await h.idle(id);
    assert.equal(h.projects.get('a').agentMemory.brief, 'Confirmed brief');
    assert.deepEqual(h.projects.get('a').agentMemory.constraints, ['Keep red']);
    assert.equal(typeof h.projects.get('a').agentMemory.confirmedAt, 'number');
    assert.equal(h.boardCalls.filter(call => call.name === 'updateProject').length, 1);
});

test('canceling before dispatch avoids any provider request', async t => {
    const h = harness(t);
    const id = h.start();
    h.runtime.cancel({ runId: id });
    assert.equal((await h.idle(id)).status, 'canceled');
    assert.equal(h.requests.length, 0);
});

test('canceling a pending provider request ignores a late completion containing board mutations', async t => {
    let gate;
    const h = harness(t, { script: [() => gate.promise] });
    gate = h.gate();
    const id = h.start();
    await until(() => h.requests.length === 1);
    const canceled = h.runtime.cancel({ runId: id });
    gate.resolve(reply('Late success', [tool('late', 'board.transaction.apply')]));
    const result = await h.idle(id);
    assert.equal(result.status, 'canceled');
    assert.equal(result.outputText, '');
    assert.equal(result.lastSeq, canceled.lastSeq);
    assert.equal(h.requests[0].signal.aborted, true);
    assert.equal(h.boardCalls.some(call => call.name === 'apply'), false);
});

test('late streamed text after cancellation is rejected without emitting another event', async t => {
    let gate;
    const h = harness(t, { script: [() => gate.promise] });
    gate = h.gate();
    const id = h.start();
    await until(() => h.requests.length === 1);
    const canceled = h.runtime.cancel({ runId: id });
    assert.throws(() => h.requests[0].onDelta('late text'), { code: 'CANCELED' });
    gate.resolve(reply());
    await h.idle(id);
    assert.equal(h.runtime.get({ runId: id }).lastSeq, canceled.lastSeq);
});

test('canceling during ask-mode preview cannot resurrect an awaiting-confirmation plan', async t => {
    let gate;
    const h = harness(t, { script: [reply('', [tool('apply', 'board.transaction.apply', { operations: [] })])],
        board: { preview: () => gate.promise } });
    gate = h.gate({ valid: true });
    const id = h.start({ mode: 'ask' });
    await until(() => h.boardCalls.some(call => call.name === 'preview'));
    const canceled = h.runtime.cancel({ runId: id });
    gate.resolve({ valid: true });
    const result = await h.idle(id);
    assert.equal(result.status, 'canceled');
    assert.equal(result.lastSeq, canceled.lastSeq);
    assert.equal(result.plan, null);
});

test('canceling an in-flight asset read ignores its late tool result and leaves the event cursor unchanged', async t => {
    let gate;
    const h = harness(t, { script: [reply('', [tool('read', 'asset.read', { nodeId: 'image-1' })])], readMedia: () => gate.promise });
    gate = h.gate({ images: [image], evidence: { nodeId: 'image-1' } });
    const id = h.start();
    await until(() => h.mediaCalls.length === 1);
    const canceled = h.runtime.cancel({ runId: id });
    gate.resolve({ images: [image], evidence: { nodeId: 'image-1' } });
    const result = await h.idle(id);
    assert.equal(result.status, 'canceled');
    assert.equal(result.lastSeq, canceled.lastSeq);
    assert.equal(h.events.filter(event => event.seq > canceled.lastSeq && event.type === 'tool_result').length, 0);
});

test('max turns caps a repeated tool loop and saves completed tool progress without another request', async t => {
    const h = harness(t, { maxTurns: 2, script: [reply('', [tool('one', 'memory.read')]), reply('', [tool('two', 'memory.read')])] });
    const id = h.start();
    const result = await h.idle(id);
    assert.equal(result.status, 'failed');
    assert.equal(result.turns, 2);
    assert.equal(h.requests.length, 2);
    assert.equal(h.disk(id).messages.filter(message => message.role === 'tool').length, 2);
    assert.equal(h.disk(id).pendingCalls.length, 0);
});

test('a provider response exceeding the per-turn tool limit performs no requested mutations', async t => {
    const h = harness(t, { script: [reply('', Array.from({ length: 33 }, (_, index) => tool(`call-${index}`, 'board.transaction.apply')))] });
    const result = await h.idle(h.start());
    assert.equal(result.status, 'failed');
    assert.equal(h.boardCalls.some(call => call.name === 'apply'), false);
});

test('unsupported-tool fallback is chat-only and never executes tool-like prose', async t => {
    const h = harness(t, { script: [reply('flow_canvas.board.transaction.apply({"operations":[]})', [], { toolSupport: 'unavailable' })] });
    const result = await h.idle(h.start());
    assert.equal(result.status, 'completed');
    assert.equal(result.chatOnly, true);
    assert.ok(result.outputText.startsWith('flow_canvas.board.transaction.apply'));
    assert.equal(h.boardCalls.some(call => call.name === 'apply'), false);
    assert.equal(h.stepCalls.length, 0);
});

test('partial generation failure preserves the first saved result and marks only the second step failed', async t => {
    const h = harness(t, { script: [reply('', [tool('batch', 'graph.run', { nodeIds: ['one', 'two'], summary: 'Batch' })])],
        executeStep: async step => {
            if (step.id === 'step-two') throw new Error('Second generation failed');
            return { nodeIds: ['saved-first'], filePath: '/saved/first.png' };
        } });
    const id = h.start();
    await h.idle(id);
    h.confirm(id);
    const result = await h.idle(id);
    assert.equal(result.status, 'partial_failed');
    assert.deepEqual(result.steps.map(step => step.status), ['completed', 'failed']);
    assert.equal(result.results.length, 1);
    assert.equal(h.disk(id).results[0].filePath, '/saved/first.png');
    h.runtime.resume({ runId: id });
    const resumed = await h.idle(id);
    assert.equal(resumed.status, 'partial_failed');
    assert.equal(h.stepCalls.length, 2, 'failed paid steps require a new confirmation, not an automatic resubmission');
});

test('restart recovers a remote task by its saved ID with resume=true rather than submitting again', async t => {
    const h = harness(t, { initialRuns: [recoveryRun()], script: [reply('Review saved output'), reply('Recovered')],
        executeStep: async (step, run, context) => {
            assert.equal(step.remoteTaskId, 'remote-existing');
            assert.equal(context.resume, true);
            return { nodeIds: ['recovered-output'] };
        } });
    assert.equal(h.runtime.get({ runId: 'agent-recovery' }).status, 'interrupted');
    h.runtime.resume({ runId: 'agent-recovery' });
    const result = await h.idle('agent-recovery');
    assert.equal(result.status, 'completed');
    assert.equal(h.stepCalls.length, 1);
    assert.equal(h.disk('agent-recovery').steps[0].remoteTaskId, 'remote-existing');
    assert.deepEqual(toolResults(h.requests[1]).map(result => result.id), ['generate']);
    assert.equal(h.providerBindings[0].kind, 'text');
});

for (const status of ['submitting', 'unknown', 'submitted']) {
    test(`recovery refuses ${status} generation without a remote task ID and never resubmits`, async t => {
        const h = harness(t, { initialRuns: [recoveryRun({ status, remoteTaskId: undefined })] });
        assert.throws(() => h.runtime.resume({ runId: 'agent-recovery' }), { code: 'SUBMISSION_UNKNOWN' });
        assert.equal(h.stepCalls.length, 0);
        assert.equal(h.requests.length, 0);
        assert.equal(h.runtime.get({ runId: 'agent-recovery' }).status, 'interrupted');
    });
}

test('recovery skips completed paid steps and executes only a never-submitted queued step', async t => {
    const saved = { nodeIds: ['saved-before-restart'] };
    const seed = recoveryRun({}, { steps: [
        { id: 'completed', status: 'completed', result: saved }, { id: 'queued', status: 'queued' }
    ], results: [{ stepId: 'completed', ...saved }] });
    const h = harness(t, { initialRuns: [seed], script: [reply('Review'), reply()] });
    h.runtime.resume({ runId: seed.id });
    const result = await h.idle(seed.id);
    assert.equal(result.status, 'completed');
    assert.deepEqual(h.stepCalls.map(call => call.step.id), ['queued']);
    assert.equal(h.stepCalls[0].context.resume, false);
    assert.equal(result.results.length, 2);
    assert.deepEqual(result.results[0].nodeIds, ['saved-before-restart']);
});

test('generation checkpoints persist the remote ID before a polling failure and resume the same task', async t => {
    let attempt = 0;
    const h = harness(t, { script: [reply('', [graphCall()]), reply('Review'), reply()],
        executeStep: async (step, run, context) => {
            if (++attempt === 1) {
                context.checkpoint({ status: 'submitting' });
                context.checkpoint({ status: 'submitted', remoteTaskId: 'remote-checkpoint' });
                assert.equal(h.disk(run.id).steps[0].remoteTaskId, 'remote-checkpoint');
                throw new Error('Polling connection dropped');
            }
            assert.equal(context.resume, true);
            assert.equal(step.remoteTaskId, 'remote-checkpoint');
            return { nodeIds: ['finished-remote'] };
        } });
    const id = h.start();
    await h.idle(id);
    h.confirm(id);
    assert.equal((await h.idle(id)).status, 'failed');
    assert.equal(h.disk(id).steps[0].status, 'submitted');
    h.runtime.resume({ runId: id });
    assert.equal((await h.idle(id)).status, 'completed');
    assert.equal(attempt, 2);
});

test('canceling a submitted generation ignores a late completion without losing the saved remote ID', async t => {
    let gate;
    const h = harness(t, { script: [reply('', [graphCall()])], executeStep: async (step, run, context) => {
        context.checkpoint({ status: 'submitted', remoteTaskId: 'cancel-remote' });
        return gate.promise;
    } });
    gate = h.gate({ nodeIds: ['late-output'] });
    const id = h.start();
    await h.idle(id);
    h.confirm(id);
    await until(() => h.stepCalls.length === 1);
    const canceled = h.runtime.cancel({ runId: id });
    gate.resolve({ nodeIds: ['late-output'] });
    const result = await h.idle(id);
    assert.equal(result.status, 'canceled');
    assert.equal(result.results.length, 0);
    assert.equal(result.lastSeq, canceled.lastSeq);
    assert.equal(h.disk(id).steps[0].remoteTaskId, 'cancel-remote');
});

test('review provider failure preserves saved generation and continues without regeneration', async t => {
    const h = harness(t, { script: [reply('', [graphCall()]), () => { throw new Error('Review unavailable'); }, reply('Output saved')] });
    const id = h.start();
    await h.idle(id);
    h.confirm(id);
    const result = await h.idle(id);
    assert.equal(result.status, 'completed');
    assert.equal(result.results.length, 1);
    assert.equal(h.disk(id).steps[0].status, 'completed');
    assert.match(result.review, /Review unavailable/);
    assert.equal(h.stepCalls.length, 1);
    assert.equal(toolResults(h.requests[2])[0].value.completed, true);
});

test('review media-read failure records an unverified review but does not discard the saved image', async t => {
    const h = harness(t, { script: [reply('', [graphCall()]), reply('Saved, review unavailable')],
        readMedia: async () => { throw new Error('Cannot inspect saved file'); } });
    const id = h.start();
    await h.idle(id);
    h.confirm(id);
    const result = await h.idle(id);
    assert.equal(result.status, 'completed');
    assert.match(result.review, /Cannot inspect saved file/);
    assert.equal(result.results.length, 1);
    assert.equal(h.stepCalls.length, 1);
});

test('structured credentials, Bearer tokens and standard API keys never appear in persisted runs or emitted events', async t => {
    const h = harness(t, { script: [reply('', [tool('models', 'model.list')]), request => {
        request.onDelta(`Bearer token-hidden ${provider.apiKey}`);
        return reply(`Key ${provider.apiKey}`);
    }], listModels: () => [{ id: 'model', apiKey: 'nested-key', headers: { Authorization: 'Bearer nested-auth' },
        nested: { password: 'nested-password', secret: 'nested-secret', accessToken: 'nested-token' } }] });
    const id = h.start({ provider, attachments: [{ apiKey: 'attachment-key', sourceNodeId: 'image-1' }] });
    await h.idle(id);
    const persisted = JSON.stringify(h.disk(id));
    const emitted = JSON.stringify(h.events);
    for (const secret of [provider.apiKey, 'nested-key', 'nested-auth', 'nested-password', 'nested-secret', 'nested-token', 'attachment-key', 'token-hidden']) {
        assert.equal(persisted.includes(secret), false, `disk exposed ${secret}`);
        assert.equal(emitted.includes(secret), false, `events exposed ${secret}`);
    }
    assert.equal(h.requests[0].provider.apiKey, provider.apiKey, 'credentials are still available to the provider in memory');
});

test('an opaque configured provider key echoed in assistant text is scrubbed from disk and events', async t => {
    const secret = 'relay-opaque-credential-fixture-987654';
    const h = harness(t, { provider: { ...provider, apiKey: secret }, script: [request => {
        request.onDelta(`Echo ${secret} ${'padding '.repeat(20)}`);
        return reply(`Gateway echoed ${secret}`);
    }] });
    const id = h.start();
    assert.equal((await h.idle(id)).status, 'completed');
    assert.equal(JSON.stringify(h.disk(id)).includes(secret), false, 'disk must not contain the configured credential');
    assert.equal(JSON.stringify(h.events).includes(secret), false, 'events must not contain the configured credential');
});

test('asset image pixels reach only the next provider turn and are never persisted or broadcast', async t => {
    const h = harness(t, { script: [reply('', [tool('read', 'asset.read', { nodeId: 'image-1' })]),
        reply('', [tool('memory', 'memory.read')]), reply()] });
    const id = h.start();
    await h.idle(id);
    const visualMessage = h.requests[1].messages.at(-1);
    assert.equal(visualMessage.role, 'user');
    assert.deepEqual(visualMessage.content.at(-1), image);
    assert.equal(h.requests[2].messages.some(message => Array.isArray(message.content)), false);
    assert.equal(JSON.stringify(h.disk(id)).includes(image.image_url.url), false);
    assert.equal(JSON.stringify(h.events).includes(image.image_url.url), false);
    assert.equal(h.runtime.visuals.has(id), false);
});

test('event cursors return strictly newer ordered events and repeated reads do not mutate task state', async t => {
    let gate;
    const h = harness(t, { script: [request => { request.onDelta('First'.repeat(24)); return gate.promise; }] });
    gate = h.gate();
    const id = h.start();
    await until(() => h.events.some(event => event.type === 'text_delta'));
    const first = h.runtime.get({ runId: id });
    gate.resolve(reply('First and final'));
    const final = await h.idle(id);
    const next = h.runtime.get({ runId: id, afterSeq: first.lastSeq });
    assert.ok(next.events.length > 0);
    assert.ok(next.events.every(event => event.seq > first.lastSeq));
    assert.deepEqual([...first.events, ...next.events].map(event => event.seq), final.events.map(event => event.seq));
    assert.equal(new Set(final.events.map(event => event.seq)).size, final.events.length);
    assert.deepEqual(h.runtime.get({ runId: id, afterSeq: final.lastSeq }).events, []);
    assert.deepEqual(h.runtime.get({ runId: id, afterSeq: first.lastSeq }), next);
    assert.deepEqual(h.runtime.list({ projectId: 'a' })[0].events, []);
});

for (const action of ['get', 'cancel']) {
    test(`provider task.${action} refuses access to another project's run`, async t => {
        let targetId;
        const h = harness(t, { script: [reply('', [tool('target-memory', 'memory.propose', { brief: 'Pending', constraints: [] })]),
            () => reply('', [tool('cross-project', `task.${action}`, { runId: targetId })]), reply()] });
        targetId = h.start({ projectId: 'b', conversationId: 'private-b' });
        await h.idle(targetId);
        const id = h.start({ projectId: 'a' });
        assert.equal((await h.idle(id)).status, 'completed');
        assert.equal(toolResults(h.requests[2])[0].value.error.code, 'PROJECT_MISMATCH');
        assert.equal(h.runtime.get({ runId: targetId }).status, 'awaiting_confirmation');
        assert.equal(JSON.stringify(toolResults(h.requests[2])).includes('private-b'), false);
    });
}

test('provider task.list only returns runs from its bound project', async t => {
    const h = harness(t, { script: [reply('Private b result'), reply('', [tool('list', 'task.list')]), reply()] });
    const other = h.start({ projectId: 'b', conversationId: 'private-b' });
    await h.idle(other);
    const id = h.start({ projectId: 'a' });
    await h.idle(id);
    const tasks = toolResults(h.requests[2])[0].value;
    assert.ok(tasks.length > 0);
    assert.ok(tasks.every(run => run.projectId === 'a'));
    assert.equal(tasks.some(run => run.id === other), false);
});

for (const action of ['get', 'cancel', 'confirm', 'revise']) {
    test(`public runtime ${action} rejects an explicitly mismatched project binding`, async t => {
        const h = harness(t, { script: [reply('', [tool('pending', 'memory.propose', { brief: 'Private b brief', constraints: [] })])] });
        const id = h.start({ projectId: 'b', conversationId: 'private-b' });
        const run = await h.idle(id);
        assert.throws(() => h.runtime[action]({ runId: id, projectId: 'a', planVersion: run.plan.version,
            instruction: 'Replace the other project brief' }), { code: 'PROJECT_MISMATCH' });
        assert.equal(h.runtime.get({ runId: id }).status, 'awaiting_confirmation');
    });
}

test('public runtime resume rejects an explicitly mismatched project before polling a paid task', t => {
    const h = harness(t, { initialRuns: [recoveryRun({}, { projectId: 'b' })] });
    assert.throws(() => h.runtime.resume({ runId: 'agent-recovery', projectId: 'a' }), { code: 'PROJECT_MISMATCH' });
    assert.equal(h.stepCalls.length, 0);
    assert.equal(h.requests.length, 0);
});

test('restart preserves a pending confirmation and its version without approving or submitting it', async t => {
    const seed = recoveryRun({}, { status: 'awaiting_confirmation', steps: [], plan: { kind: 'generation', approved: false,
        version: 'pending-version', steps: [{ id: 'step-image-1', title: 'Image' }] } });
    const h = harness(t, { initialRuns: [seed] });
    const run = h.runtime.get({ runId: seed.id });
    assert.equal(run.status, 'awaiting_confirmation');
    assert.equal(run.plan.version, 'pending-version');
    assert.equal(h.disk(seed.id).pendingCalls[0].id, 'generate');
    assert.equal(h.requests.length, 0);
    assert.equal(h.stepCalls.length, 0);
});

test('run store rejects path traversal and ignores corrupt or temporary records during recovery', t => {
    const h = harness(t);
    assert.throws(() => h.runStore.save({ id: '../outside' }), /Invalid Agent run id/);
    const seed = recoveryRun();
    h.runStore.save(seed);
    fs.writeFileSync(path.join(h.directory, 'agent-corrupt.json'), '{');
    fs.writeFileSync(path.join(h.directory, 'agent-unfinished.json.tmp'), JSON.stringify({ id: 'agent-unfinished' }));
    assert.deepEqual(h.runStore.loadAll().map(run => run.id), [seed.id]);
    assert.equal(fs.existsSync(path.join(h.directory, `${seed.id}.json.tmp`)), false);
});
