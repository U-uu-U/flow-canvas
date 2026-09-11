import test from 'node:test';
import assert from 'node:assert/strict';
import { collectUpstreamMediaAttachments, collectUpstreamPromptContext } from './agent-attachments.js';

test('Agent context reuses saved upstream text without mixing it with live text', () => {
    const target = { id: 'target', kind: 'op', nodeType: 'image', config: { prompt: '', generationUpstreamPrompts: ['saved'] } };
    assert.equal(collectUpstreamPromptContext({ targetNodeId: 'target', items: [target] }).effectivePrompt, 'saved');
    const source = { id: 'text', kind: 'op', nodeType: 'text', config: { text: 'live' } };
    const context = collectUpstreamPromptContext({ targetNodeId: 'target', items: [target, source],
        connections: [{ from: { nodeId: 'text' }, to: { nodeId: 'target' } }] });
    assert.equal(context.effectivePrompt, 'live');
});

test('collects and de-duplicates transitive upstream media in nearest-first order', () => {
    const items = [
        { id: 'target', kind: 'op', nodeType: 'image' },
        { id: 'prompt', kind: 'op', nodeType: 'text' },
        { id: 'image-a', kind: 'media', mediaType: 'image', filePath: 'C:\\assets\\a.png', width: 640, height: 480 },
        { id: 'video-a', kind: 'media', mediaType: 'video', filePath: 'C:\\assets\\clip.mp4' }
    ];
    const connections = [
        { from: { nodeId: 'prompt' }, to: { nodeId: 'target' } },
        { from: { nodeId: 'image-a' }, to: { nodeId: 'target' } },
        { from: { nodeId: 'image-a' }, to: { nodeId: 'prompt' } },
        { from: { nodeId: 'video-a' }, to: { nodeId: 'prompt' } }
    ];

    const result = collectUpstreamMediaAttachments({ targetNodeId: 'target', items, connections });

    assert.deepEqual(result.map(entry => entry.name), ['a.png', 'clip.mp4']);
    assert.equal(result[0].depth, 1);
    assert.equal(result[1].depth, 2);
});

test('includes generated stacks and follows history provenance edges', () => {
    const items = [
        { id: 'target', kind: 'op', nodeType: 'video' },
        { id: 'result', kind: 'media', mediaType: 'image', filePath: 'C:\\assets\\result.png' },
        {
            id: 'generator',
            kind: 'op',
            nodeType: 'image',
            resultEntries: [
                { filePath: 'C:\\assets\\result.png' },
                { filePath: 'C:\\assets\\alternate.webp' }
            ]
        },
        { id: 'reference', kind: 'media', mediaType: 'audio', filePath: 'C:\\assets\\voice.wav' }
    ];
    const connections = [
        { from: { nodeId: 'result' }, to: { nodeId: 'target' } },
        { kind: 'history', from: { nodeId: 'generator' }, to: { nodeId: 'result' } },
        { from: { nodeId: 'reference' }, to: { nodeId: 'generator' } }
    ];

    const result = collectUpstreamMediaAttachments({ targetNodeId: 'target', items, connections });

    assert.deepEqual(result.map(entry => entry.name), ['result.png', 'alternate.webp', 'voice.wav']);
});

test('supports transient composer sources that are not connected yet', () => {
    const items = [
        { id: 'target', kind: 'op', nodeType: 'image' },
        { id: 'draft-source', kind: 'media', filePath: 'C:\\assets\\draft.jpg' }
    ];

    const result = collectUpstreamMediaAttachments({
        targetNodeId: 'target',
        items,
        transientSourceIds: ['draft-source']
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].mediaType, 'image');
});

test('collects nested upstream prompts once and mirrors the configured merge mode', () => {
    const items = [
        { id: 'target', kind: 'op', nodeType: 'image', config: { prompt: '节点要求', promptMergeMode: 'append' } },
        { id: 'base', kind: 'op', nodeType: 'text', config: { text: '基础描述' } },
        { id: 'detail', kind: 'op', nodeType: 'text', config: { text: '补充细节', separator: ' + ' } },
        { id: 'history', kind: 'op', nodeType: 'text', config: { text: '旧提示词' } }
    ];
    const connections = [
        { from: { nodeId: 'base' }, to: { nodeId: 'detail' } },
        { from: { nodeId: 'detail' }, to: { nodeId: 'target' } },
        { kind: 'history', from: { nodeId: 'history' }, to: { nodeId: 'target' } }
    ];

    const result = collectUpstreamPromptContext({ targetNodeId: 'target', items, connections });

    assert.deepEqual(result.upstreamPrompts, ['基础描述 + 补充细节']);
    assert.deepEqual(result.upstreamTextNodeIds, ['detail', 'base']);
    assert.equal(result.effectivePrompt, '节点要求\n\n基础描述 + 补充细节');
});
