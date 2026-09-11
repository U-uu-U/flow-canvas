import test from 'node:test';
import assert from 'node:assert/strict';
import { bindReferenceCitations, referenceCitationGuide, restoreReferenceCitations, reusablePromptConfig } from './reference-citations.js';

const citationConfig = () => ({
    prompt: 'A B C', referenceCitationIds: ['a', 'b'], referenceCitationLabels: ['图一', '图二'],
    referenceCitationOffsets: { a: 0, b: 2 },
    referenceCitationOccurrences: [
        { id: 'one', connectionId: 'a', sourceNodeId: 'node-a', offset: 0 },
        { id: 'two', connectionId: 'b', sourceNodeId: 'node-b', offset: 2 },
        { id: 'three', connectionId: 'a', sourceNodeId: 'node-a', offset: 4 }
    ]
});

test('legacy reuse removes only the exact generated guide and never reapplies expanded offsets', () => {
    const config = citationConfig();
    const text = restoreReferenceCitations(config.prompt, config);
    const guide = referenceCitationGuide(config);
    const migrated = reusablePromptConfig({ config, prompt: `${guide}\n${guide}\n${text}` });
    assert.equal(migrated.prompt, text);
    assert.deepEqual(migrated.referenceCitationOccurrences, []);
    assert.deepEqual(migrated.referenceCitationOffsets, {});
    assert.equal(restoreReferenceCitations(migrated.prompt, migrated), text);
    const prose = '参考图编号与上传顺序一致，但我要保留这句话。图一是主角。';
    assert.equal(reusablePromptConfig({ config, prompt: prose }).prompt, prose);
    assert.equal(config.referenceCitationOccurrences.length, 3);
});

test('modern drafts preserve capsules and intentional empty prompts without sharing mutable state', () => {
    const draft = { ...citationConfig(), prompt: '', generationUpstreamPrompts: ['upstream'] };
    const reused = reusablePromptConfig({ promptDraftConfig: draft, prompt: 'compiled prompt' });
    assert.deepEqual(reused, draft);
    reused.referenceCitationOccurrences[0].offset = 4;
    assert.equal(draft.referenceCitationOccurrences[0].offset, 0);
});

test('binding resolves stable nodes against actual upload order, even with new connection IDs', () => {
    const config = citationConfig();
    const before = structuredClone(config);
    const refs = [{ filePath: '/b.png' }, { filePath: '/a.png' }];
    const context = ['b', 'a'].map(id => ({ connectionId: `new-${id}`, source: { id: `node-${id}`, filePath: `/${id}.png` } }));
    const bound = bindReferenceCitations(config, refs, context);
    assert.deepEqual(bound.config.referenceCitationLabels, ['图二', '图一']);
    assert.equal(restoreReferenceCitations(config.prompt, bound.config), '图二A 图一B 图二C');
    assert.deepEqual(bound.bindings.map(entry => [entry.position, entry.sourceNodeId]), [[1, 'node-b'], [2, 'node-a']]);
    assert.deepEqual(config, before);
});

test('missing source nodes cannot be silently rebound using an old connection ID or label', () => {
    const config = citationConfig();
    const refs = [{ filePath: '/other.png' }, { filePath: '/b.png' }];
    assert.throws(() => bindReferenceCitations(config, refs, [
        { connectionId: 'a', source: { id: 'different-node', filePath: '/other.png' } }
    ]), /引用素材/);
    assert.throws(() => bindReferenceCitations(config, refs), /引用素材/);
    config.referenceCitationOccurrences[0].missing = true;
    assert.throws(() => bindReferenceCitations(config, refs), /失联/);
});

test('duplicate assets share upload numbers while bindings preserve all source nodes', () => {
    const config = citationConfig();
    const context = ['a', 'b'].map(id => ({ connectionId: id, source: { id: `node-${id}`, filePath: '/same.png' } }));
    const bound = bindReferenceCitations(config, [{ filePath: '/same.png' }], context);
    assert.deepEqual(bound.config.referenceCitationLabels, ['图一', '图一']);
    assert.equal(referenceCitationGuide(bound.config), '参考图编号与上传顺序一致：图一=第1张。');
    assert.deepEqual(bound.bindings[0].sourceNodeIds, ['node-a', 'node-b']);
});

test('uncited images remain in bindings at their original upload positions', () => {
    const bound = bindReferenceCitations({}, [{ filePath: '/first.png' }, { filePath: '/second.png' }]);
    assert.deepEqual(bound.bindings.map(entry => entry.position), [1, 2]);
    assert.deepEqual(bound.config, {});
});
