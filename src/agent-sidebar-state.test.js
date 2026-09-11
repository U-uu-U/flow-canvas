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
