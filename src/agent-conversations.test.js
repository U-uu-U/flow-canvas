import test from 'node:test';
import assert from 'node:assert/strict';
import {
    deriveAgentConversationTitle,
    mergeAgentConversationFiles,
    normalizeAgentConversationProject
} from './agent-conversations.js';

const normalizeMessages = value => (Array.isArray(value) ? value : [])
    .filter(message => ['user', 'assistant'].includes(message?.role));

test('legacy project conversation migrates without losing messages', () => {
    const state = normalizeAgentConversationProject({
        messages: [{ role: 'user', content: '检查这组镜头的连续性' }],
        updatedAt: '2026-09-04T10:00:00.000Z'
    }, { normalizeMessages, createId: () => 'task-legacy', now: 100 });
    assert.equal(state.activeConversationId, 'task-legacy');
    assert.equal(state.conversations[0].title, '检查这组镜头的连续性');
    assert.equal(state.conversations[0].messages.length, 1);
});

test('conversation title is derived from the first user instruction', () => {
    assert.equal(deriveAgentConversationTitle([
        { role: 'assistant', content: 'ignored' },
        { role: 'user', content: '  帮我整理   当前画板的全部素材  ' }
    ]), '帮我整理 当前画板的全部素材');
});

test('conversation files deduplicate repeated input media and retain direction', () => {
    const files = mergeAgentConversationFiles([], [
        { mediaType: 'image', filePath: 'D:\\assets\\a.png', name: 'a.png' },
        { mediaType: 'image', filePath: 'd:\\assets\\A.png', name: 'duplicate.png' }
    ], 'input');
    assert.equal(files.length, 1);
    assert.equal(files[0].kind, 'image');
    assert.equal(files[0].direction, 'input');
    assert.match(files[0].detail, /输入/);
});

test('the same file can appear once as input and once as output', () => {
    const input = mergeAgentConversationFiles([], [
        { mediaType: 'image', filePath: 'D:\\assets\\a.png' }
    ], 'input');
    const both = mergeAgentConversationFiles(input, [
        { mediaType: 'image', filePath: 'D:\\assets\\a.png' }
    ], 'output');
    assert.deepEqual(both.map(file => file.direction), ['input', 'output']);
});

test('conversation files ignore unsupported entries and do not treat text as a file', () => {
    const files = mergeAgentConversationFiles([], [
        { mediaType: 'text', filePath: 'D:\\assets\\prompt.txt' },
        { mediaType: 'image', name: 'missing-location.png' },
        { mediaType: 'video', url: 'https://example.test/output.mp4', name: 'output.mp4' }
    ], 'output');
    assert.equal(files.length, 1);
    assert.equal(files[0].kind, 'video');
    assert.equal(files[0].direction, 'output');
});
