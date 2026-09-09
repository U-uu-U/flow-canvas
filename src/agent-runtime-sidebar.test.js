import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSidebar } from './agent-sidebar.js';
import { AgentRuntimeClient } from './agent-runtime-view.js';

function harness(start) {
    const data = new Map();
    globalThis.localStorage = {
        getItem: key => data.get(key) || null,
        setItem: (key, value) => data.set(key, value)
    };
    let legacyCalls = 0;
    globalThis.window = { flowCanvas: {
        agent: { start },
        ai: { generateText: () => { legacyCalls++; throw new Error('legacy must not run'); } }
    } };
    const sidebar = Object.create(AgentSidebar.prototype);
    Object.assign(sidebar, {
        options: { getPlanningContext: () => ({ activeGroup: { id: 'project-1' }, plans: [] }) },
        activeProjectCacheKey: 'project-1', activeRuntimeProjectId: 'project-1',
        activeConversationId: 'chat-1', messages: [], conversationFiles: [],
        pendingAgentAttachments: [], pendingAgentSource: null,
        runtimeStarting: new Set(), runtimeCards: new Map(), runtimeStartErrors: new Map(),
        globalConfig: { agentExecutionMode: 'ask' },
        sendBtn: { disabled: false }, inputEl: { value: 'hello', style: {} },
        _connectAgentRuntime() {}, _renderAgentMessages() {}, _renderAgentRuntimeCards() {},
        _renderAgentConversationHeader() {}, _renderAgentFiles() {}, _renderPendingAgentAttachments() {},
        _appendAgentError() {}, setMode() {},
        _getTextProvider: () => ({ endpoint: 'https://example.test/v1', apiKey: 'ephemeral', model: 'text-model' }),
        _agentImageSkillInstructions: () => ['skill instruction']
    });
    sidebar.runtimeClient = new AgentRuntimeClient({
        get: async ({ runId }) => sidebar.runtimeClient.runs.get(runId),
        list: async () => []
    }, { onChange: run => sidebar._onAgentRuntimeChange(run) });
    sidebar._saveAgentConversationProject('project-1', {
        activeConversationId: 'chat-1', extraProjectMetadata: 'keep',
        conversations: [
            { id: 'chat-1', title: 'custom title', customTitle: true, messages: [], files: [], extraMetadata: 'keep' },
            { id: 'chat-2', messages: [], files: [] }
        ]
    });
    return { sidebar, data, legacyCalls: () => legacyCalls };
}

test('normal and node entry points use one runtime with raw identity, source details and no legacy planning', async () => {
    const requests = [];
    const { sidebar, data, legacyCalls } = harness(async request => {
        requests.push(request);
        return { id: 'run-' + requests.length, projectId: request.projectId, conversationId: request.conversationId,
            status: 'completed', outputText: 'answer', lastSeq: 4, events: [] };
    });
    await sidebar._sendAgentMessage('normal');
    assert.equal(requests[0].projectId, 'project-1');
    assert.equal(requests[0].conversationId, 'chat-1');
    assert.equal(requests[0].mode, 'ask');
    assert.equal(requests[0].provider.apiKey, 'ephemeral');
    assert.deepEqual(requests[0].skillInstructions, ['skill instruction']);
    const details = { nodeId: 'node-1', nodeType: 'image', originalPrompt: 'original', effectivePrompt: 'effective',
        upstreamPrompts: ['upstream'], parameters: { count: 2 }, extraContext: { binding: 'keep' } };
    await sidebar.generateImageFromNode(details, 'new instruction');
    assert.deepEqual(requests[1].source.details, details);
    assert.equal(requests[1].source.originalPrompt, 'original');
    assert.equal(requests[1].source.parameters.count, 2);
    assert.equal(requests[1].messages.at(-1).content, 'new instruction');
    assert.equal(legacyCalls(), 0);
    assert.equal([...data.values()].some(value => value.includes('ephemeral')), false);
    const project = sidebar._loadAgentConversationStore()['project-1'];
    assert.equal(project.extraProjectMetadata, 'keep');
    assert.equal(project.conversations[0].extraMetadata, 'keep');
    assert.equal(project.conversations[0].title, 'custom title');
    sidebar.runtimeClient.dispose();
});

test('background start and final update only their originating conversation, consume only its attachments', async () => {
    const resolvers = [];
    const { sidebar } = harness(request => new Promise(resolve => resolvers.push({ request, resolve })));
    const attachment = { mediaType: 'image', filePath: '/a.png', name: 'a.png' };
    sidebar.pendingAgentAttachments = [attachment];
    sidebar._savePendingAgentAttachments();
    const first = sidebar._sendAgentMessage('first');
    assert.equal(sidebar.sendBtn.disabled, true);
    sidebar.activeConversationId = 'chat-2';
    sidebar.messages = [];
    sidebar.conversationFiles = [];
    sidebar.pendingAgentAttachments = [{ ...attachment, filePath: '/b.png' }];
    sidebar._savePendingAgentAttachments();
    sidebar._syncAgentRuntimeSendState();
    assert.equal(sidebar.sendBtn.disabled, false);
    const second = sidebar._sendAgentMessage('second');
    await Promise.resolve();
    const finish = (index, id) => resolvers[index].resolve({
        id, projectId: 'project-1', conversationId: resolvers[index].request.conversationId,
        status: 'completed', outputText: id + ' answer', lastSeq: 5, events: []
    });
    finish(0, 'run-1');
    await first;
    assert.deepEqual(sidebar.messages.map(message => message.content), ['second']);
    assert.equal(sidebar.pendingAgentAttachments[0].filePath, '/b.png');
    assert.equal(sidebar._loadPendingAgentAttachmentStore()['project-1::chat-1']?.attachments?.length || 0, 0);
    finish(1, 'run-2');
    await second;
    const project = sidebar._loadAgentConversationStore()['project-1'];
    assert.deepEqual(project.conversations[0].messages.map(message => message.content), ['first', 'run-1 answer']);
    assert.deepEqual(project.conversations[1].messages.map(message => message.content), ['second', 'run-2 answer']);
    sidebar._onAgentRuntimeChange(sidebar.runtimeClient.runs.get('run-1'));
    assert.equal(sidebar._loadAgentConversationStore()['project-1'].conversations[0].messages.length, 2);
    sidebar.runtimeClient.dispose();
});

test('runtime rejection retains pending attachments and never invokes legacy paid fallback', async () => {
    const { sidebar, legacyCalls } = harness(async () => { throw new Error('IPC disconnected'); });
    sidebar.pendingAgentAttachments = [{ mediaType: 'image', filePath: '/a.png' }];
    const result = await sidebar._sendAgentMessage('hello');
    assert.equal(result.ok, false);
    assert.equal(legacyCalls(), 0);
    assert.equal(sidebar.pendingAgentAttachments.length, 1);
    assert.equal(sidebar.sendBtn.disabled, false);
    sidebar.runtimeClient.dispose();
});

test('null project identity never leaks the local no-project cache sentinel into IPC', async () => {
    let request;
    const { sidebar } = harness(async value => {
        request = value;
        return { id: 'null-run', projectId: null, conversationId: 'chat-1', status: 'completed', lastSeq: 1, events: [] };
    });
    sidebar.activeRuntimeProjectId = null;
    sidebar.activeProjectCacheKey = '__no_project__';
    sidebar._saveAgentConversationProject('__no_project__', {
        activeConversationId: 'chat-1', conversations: [{ id: 'chat-1', messages: [], files: [] }]
    });
    await sidebar._sendAgentMessage('hello');
    assert.equal(request.projectId, null);
    sidebar.runtimeClient.dispose();
});

test('deleted originating conversations are not recreated or redirected to surviving chats', () => {
    const { sidebar } = harness(async () => {});
    const before = JSON.stringify(sidebar._loadAgentConversationStore());
    sidebar._onAgentRuntimeChange({
        id: 'deleted-run', projectId: 'project-1', conversationId: 'deleted',
        status: 'completed', outputText: 'must not leak', lastSeq: 1, events: []
    });
    assert.equal(JSON.stringify(sidebar._loadAgentConversationStore()), before);
    sidebar.runtimeClient.dispose();
});

test('flush conflicts abort before runtime start and retain pending attachments', async () => {
    let starts = 0;
    const { sidebar } = harness(async () => { starts++; });
    sidebar.options.flushBoard = async () => false;
    sidebar.pendingAgentAttachments = [{ mediaType: 'image', filePath: '/a.png' }];
    const result = await sidebar._sendAgentMessage('hello');
    assert.equal(starts, 0);
    assert.equal(result.ok, false);
    assert.match(result.reason, /保存冲突/);
    assert.equal(sidebar.pendingAgentAttachments.length, 1);
    assert.equal(sidebar.sendBtn.disabled, false);
    sidebar.runtimeClient.dispose();
});

test('awaiting board flush does not change the captured project or conversation', async () => {
    let finishFlush;
    let received;
    const { sidebar } = harness(async request => {
        received = request;
        return { id: 'flushed-run', projectId: request.projectId, conversationId: request.conversationId,
            status: 'completed', outputText: 'original reply', lastSeq: 2, events: [] };
    });
    sidebar.options.flushBoard = () => new Promise(resolve => { finishFlush = resolve; });
    const pending = sidebar._sendAgentMessage('original request');
    sidebar.activeProjectCacheKey = 'project-2';
    sidebar.activeRuntimeProjectId = 'project-2';
    sidebar.activeConversationId = 'chat-2';
    sidebar.messages = [];
    finishFlush(true);
    await pending;
    assert.equal(received.projectId, 'project-1');
    assert.equal(received.conversationId, 'chat-1');
    assert.deepEqual(sidebar.messages, []);
    sidebar.runtimeClient.dispose();
});

test('start sends the full normalized history and selected non-file nodes without a system prompt', async () => {
    let received;
    const { sidebar } = harness(async request => {
        received = request;
        return { id: 'selection-run', projectId: request.projectId, conversationId: request.conversationId,
            status: 'completed', lastSeq: 1, events: [] };
    });
    sidebar.messages = Array.from({ length: 40 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user', content: 'message-' + index, runtimeRunId: 'metadata-only'
    }));
    sidebar.lastCanvasSelection = [{ id: 'stale-node' }];
    sidebar.options.getSelectedCanvasEntries = () => [
        { id: 'text-node', filePath: null }, { id: 'plan-node', filePath: null }, { id: 'text-node' }
    ];
    sidebar.options.getPlanningContext = () => { throw new Error('runtime must not serialize planning context'); };
    await sidebar._sendAgentMessage('new request');
    assert.deepEqual(received.selectedItemIds, ['text-node', 'plan-node']);
    assert.deepEqual(received.attachments, []);
    assert.equal(received.messages.length, 41);
    assert.deepEqual(received.messages[0], { role: 'user', content: 'message-0' });
    assert.equal(received.messages.some(message => message.role === 'system'), false);
    sidebar.runtimeClient.dispose();
});

test('selection is captured before flushing and empty current selection never reuses stale nodes', async () => {
    const requests = [];
    const { sidebar } = harness(async request => {
        requests.push(request);
        return { id: 'selection-' + requests.length, projectId: request.projectId, conversationId: request.conversationId,
            status: 'completed', lastSeq: 1, events: [] };
    });
    sidebar.lastCanvasSelection = [{ id: 'subscription-node' }];
    sidebar.options.flushBoard = async () => { sidebar.lastCanvasSelection = [{ id: 'changed-node' }]; return true; };
    await sidebar._sendAgentMessage('first');
    assert.deepEqual(requests[0].selectedItemIds, ['subscription-node']);
    sidebar.options.getSelectedCanvasEntries = () => [];
    await sidebar._sendAgentMessage('second');
    assert.deepEqual(requests[1].selectedItemIds, []);
    sidebar.runtimeClient.dispose();
});

test('rehydrating results-only snapshots saves files and keeps the final reply unique', () => {
    const { sidebar } = harness(async () => {});
    const run = { id: 'saved-run', projectId: 'project-1', conversationId: 'chat-1',
        status: 'completed', outputText: 'saved answer', lastSeq: 6, events: [],
        results: [{ filePaths: ['/output.png'] }], review: 'saved review' };
    sidebar._onAgentRuntimeChange(run);
    sidebar._onAgentRuntimeChange(run);
    const conversation = sidebar._loadAgentConversationStore()['project-1'].conversations[0];
    assert.equal(conversation.files[0].filePath, '/output.png');
    assert.equal(conversation.messages.filter(message => message.role === 'assistant').length, 1);
    sidebar.runtimeClient.dispose();
});
