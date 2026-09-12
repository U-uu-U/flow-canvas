import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSidebar } from './agent-sidebar.js';

test('node prompt presets remain independent by project and media kind without workspace DOM', t => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const values = new Map();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value)
    } });
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
        else delete globalThis.localStorage;
    });
    const sidebar = Object.create(AgentSidebar.prototype);
    sidebar.activeProjectCacheKey = 'project-a';
    const image = sidebar.savePromptPreset('image', { name: 'Portrait', prompt: 'image prompt' });
    const video = sidebar.savePromptPreset('video', { name: 'Portrait', prompt: 'video prompt' });
    sidebar.activeProjectCacheKey = 'project-b';
    assert.deepEqual(sidebar.getPromptPresets('image'), []);
    assert.equal(sidebar.deletePromptPreset('image', image.id), false);
    sidebar.savePromptPreset('image', { name: 'Portrait', prompt: 'other project' });
    sidebar.activeProjectCacheKey = 'project-a';
    assert.equal(sidebar.getPromptPresets('image')[0].prompt, 'image prompt');
    assert.equal(sidebar.getPromptPresets('video')[0].id, video.id);
    const edited = sidebar.savePromptPreset('image', { id: image.id, name: 'Edited', prompt: 'new prompt' });
    assert.equal(edited.id, image.id);
    assert.equal(sidebar.getPromptPresets('image').length, 1);
    assert.equal(sidebar.deletePromptPreset('image', image.id), true);
    assert.deepEqual(sidebar.getPromptPresets('image'), []);
    assert.equal(sidebar.getPromptPresets('video')[0].prompt, 'video prompt');
    sidebar.activeProjectCacheKey = 'project-b';
    assert.equal(sidebar.getPromptPresets('image')[0].prompt, 'other project');
});

test('task submission, recovery and progress remain tied to their task without generation workspace DOM', () => {
    const sidebar = Object.create(AgentSidebar.prototype);
    const task = { id: 'task-a', status: 'running', projectId: 'project-a', params: { duration: 30 } };
    const other = { id: 'task-b', status: 'running', projectId: 'project-b', params: { duration: 30 } };
    sidebar.generationTasks = [task, other];
    sidebar._updateGenerationTask = (id, patch) => Object.assign(sidebar.generationTasks.find(item => item.id === id), patch);
    sidebar._handleTaskSubmitted({ clientTaskId: task.id, remoteTaskId: 'remote-a', recovering: true });
    assert.equal(task.taskId, 'remote-a');
    assert.equal(task.params.syncStage, 'recovering');
    sidebar._handleVideoProgress({ clientTaskId: task.id, stage: 'processing', progress: 70 });
    assert.equal(task.params.progress, 70);
    assert.equal(task.params.duration, 30);
    sidebar._handleTaskSubmitted({ remoteTaskId: 'remote-a', recovered: true });
    assert.equal(task.params.syncStage, null);
    sidebar._handleTaskCompleted({ remoteTaskId: 'remote-a', recovered: true, filePath: '/output.mp4' });
    assert.equal(task.status, 'success');
    assert.equal(task.filePath, '/output.mp4');
    assert.equal(task.projectId, 'project-a');
    assert.deepEqual(other, { id: 'task-b', status: 'running', projectId: 'project-b', params: { duration: 30 } });
});

function retrySidebar(t, task, generate) {
    const oldWindow = globalThis.window;
    t.after(() => { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; });
    globalThis.window = { flowCanvas: { mcp: { generateImage: generate, generateVideo: generate } } };
    const sidebar = Object.create(AgentSidebar.prototype);
    sidebar.options = { getActiveProjectId: () => 'other', flushBoard: async () => true,
        beginImageGeneration: () => assert.fail('must not create a placeholder in another project'),
        beginVideoGeneration: () => assert.fail('must not create a placeholder in another project') };
    sidebar.generationTasks = [task];
    sidebar.providers = [{ id: 'api', apiKey: 'test-only', endpoint: 'https://example.test/v1', model: task.model }];
    sidebar._updateGenerationTask = (_id, patch) => {
        const params = { ...task.params, ...patch.params };
        Object.assign(task, patch, { params });
    };
    sidebar._recordGenerationError = (_id, error) => { task.status = 'failed'; task.error = error.message; };
    return sidebar;
}

test('image retry retains the complete MJ snapshot and targets the original project', async t => {
    const task = { id: 'retry-image', kind: 'image', status: 'failed', providerId: 'api', model: 'mj_imagine',
        projectId: 'original', prompt: 'original prompt', sourcePaths: ['/reference.png'],
        params: { size: '1024x1024', quality: 'high', webSearch: false, targetDir: '/original-output', nodeId: 'node',
            midjourney: { version: '7', stylize: 200, chaos: 10, raw: true, definition: 'sd', negativePrompt: 'letters' } } };
    let sent;
    const sidebar = retrySidebar(t, task, async body => { sent = body; return { filePath: '/one.png', filePaths: ['/one.png', '/two.png'], nodeId: 'node' }; });
    sidebar._prepareImageReferencesForGeneration = async references => ({ references });
    await sidebar._retryGenerationTask(task.id);
    assert.equal(task.status, 'success', task.error);
    assert.equal(sent.projectId, 'original');
    assert.equal(sent.targetDir, '/original-output');
    assert.deepEqual(sent.midjourney, task.params.midjourney);
    assert.equal(sent.addToCanvas, false);
    assert.equal(sent.restoreToProject, true);
    assert.equal(task.filePaths.length, 2);
});

test('image retry preserves web search and blocks duplicate clicks during reference preparation', async t => {
    const task = { id: 'retry', kind: 'image', status: 'failed', providerId: 'api', model: 'gpt-image-2',
        projectId: 'original', prompt: 'prompt', sourcePaths: ['/reference.png'], params: { size: '1024x1024', webSearch: true } };
    let release, submitted = 0;
    const sidebar = retrySidebar(t, task, async body => { submitted++; assert.equal(body.webSearch, true); return { filePath: '/one.png' }; });
    sidebar._prepareImageReferencesForGeneration = references => new Promise(resolve => { release = () => resolve({ references }); });
    const first = sidebar._retryGenerationTask(task.id);
    await new Promise(resolve => setImmediate(resolve));
    await sidebar._retryGenerationTask(task.id);
    release();
    await first;
    assert.equal(submitted, 1, task.error);
    assert.equal(sidebar.retryingGenerationTasks.size, 0);
});

test('video retry normalizes legacy H3 resolution and validates before submission', async t => {
    const task = { id: 'retry-video', kind: 'video', status: 'failed', providerId: 'api', model: 'minimax-h3',
        projectId: 'original', prompt: 'prompt', sourcePaths: [], params: { resolution: '720p', ratio: '16:9', duration: 6 } };
    let sent;
    const sidebar = retrySidebar(t, task, async body => { sent = body; return { filePath: '/one.mp4' }; });
    await sidebar._retryGenerationTask(task.id);
    assert.equal(task.status, 'success', task.error);
    assert.equal(sent.resolution, '768p');
    task.status = 'failed'; task.filePath = null; task.params.duration = 999;
    sent = null;
    await sidebar._retryGenerationTask(task.id);
    assert.equal(sent, null);
    assert.equal(task.status, 'failed');
});

test('existing remote IDs use recovery instead of a new generation', async t => {
    const task = { id: 'known', kind: 'image', status: 'disconnected', taskId: 'remote' };
    const sidebar = retrySidebar(t, task, () => assert.fail('must not resubmit'));
    let recovered;
    sidebar._recoverGenerationTask = id => { recovered = id; };
    await sidebar._retryGenerationTask(task.id);
    assert.equal(recovered, task.id);
});
