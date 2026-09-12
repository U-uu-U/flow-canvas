import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGeneratorStackResult } from './generation-result-state.mjs';
import { getGeneratorPlaceholderSize } from '../src/generator-placeholder-layout.js';
import { rotateGeneratorResults } from '../src/generator-result-stack.js';

const source = (nodeType = 'image') => ({
    id: 'source', kind: 'op', nodeType, config: { prompt: 'draft' },
    x: 10, y: 20, width: 400, height: 300,
    runStatus: 'running', runError: 'previous error', runStartedAt: 123
});

test('partial batch results preserve status and errors until explicitly completed', () => {
    const node = source();
    const before = structuredClone(node);
    assert.equal(applyGeneratorStackResult(node, { _resultFilePath: '/one.png' }), node);
    assert.equal(node.runStatus, 'running');
    assert.equal(node.runError, 'previous error');
    applyGeneratorStackResult(node, { _resultFilePath: '/two.png' }, { completed: false });
    applyGeneratorStackResult(node, { _resultFilePath: '/two.png' }, { completed: 'true' });
    assert.equal(node.runStatus, 'running');
    assert.equal(node.runError, 'previous error');
    applyGeneratorStackResult(node, { _resultFilePath: '/three.png' }, { completed: true });
    assert.equal(node.runStatus, 'done');
    assert.equal(node.runError, '');
    assert.deepEqual(node.resultFilePaths, ['/one.png', '/two.png', '/three.png']);
    for (const key of ['id', 'kind', 'nodeType', 'config', 'x', 'y', 'width', 'height', 'runStartedAt']) {
        assert.deepEqual(node[key], before[key]);
    }
    assert.equal(node.filePath, undefined);
});

test('empty results and non-generators are no-ops even with completed true', () => {
    for (const output of [undefined, {}, { _resultItem: { candidateIndex: 1 }, _generation: { taskId: 'task' }, _preserveGeneratorStack: true }]) {
        const node = source();
        const before = structuredClone(node);
        assert.equal(applyGeneratorStackResult(node, output, { completed: true }), null);
        assert.deepEqual(node, before);
    }
    for (const node of [null, { ...source(), kind: 'media' }, { ...source(), nodeType: 'text' }]) {
        const before = structuredClone(node);
        assert.equal(applyGeneratorStackResult(node, { _resultFilePath: '/one.png' }, { completed: true }), null);
        assert.deepEqual(node, before);
    }
});

test('provenance is cloned with output precedence, preserved timestamps and an injectable fallback time', () => {
    const node = source();
    const generation = { taskId: 'fallback', config: { prompt: 'fallback' } };
    const output = { _resultFilePath: '/one.png', _generation: { taskId: 'output', generatedAt: 42, config: { prompt: 'raw' } },
        _resultItem: { generation: { references: [{ filePath: '/reference.png' }] } } };
    const before = structuredClone(output);
    applyGeneratorStackResult(node, output, { generation, now: 99 });
    assert.deepEqual(node.generation, output._generation);
    node.generation.config.prompt = 'edited';
    node.resultItems[0].generation.references[0].filePath = '/edited.png';
    assert.deepEqual(output, before);
    applyGeneratorStackResult(node, { _resultFilePath: '/two.png' }, { generation, now: 99 });
    assert.deepEqual(node.generation, { ...generation, generatedAt: 99 });
    assert.equal(generation.generatedAt, undefined);
    const stored = structuredClone(node.generation);
    applyGeneratorStackResult(node, { _resultFilePath: '/three.png' });
    assert.deepEqual(node.generation, stored);
});

test('candidate overrides, URL results, legacy stacks and repeated paths retain stack semantics', () => {
    const node = { ...source(), resultFilePaths: ['C:/one.png'], resultItems: [{ candidateIndex: 1 }], resultStackPosition: 0 };
    applyGeneratorStackResult(node, { _resultFilePath: 'c:\\one.png', _candidateIndex: 2, _resultItem: { candidateIndex: 9 }, _preserveGeneratorStack: true });
    applyGeneratorStackResult(node, { _resultUrl: 'https://cdn.example/two.png', _resultItem: { candidateIndex: 4 } });
    assert.equal(node.resultEntries.length, 2);
    assert.deepEqual(node.resultItems.map(item => item.candidateIndex), [2, 4]);
    assert.equal(node.preserveGeneratorStack, true);
    rotateGeneratorResults(node);
    applyGeneratorStackResult(node, { _resultUrl: 'https://cdn.example/two.png', _resultItem: { candidateIndex: 4 } });
    assert.deepEqual(node.resultItems.map(item => item.candidateIndex), [4, 2]);
    assert.equal(node.resultStackPosition, 1);
    applyGeneratorStackResult(node, { _resultItem: { filePath: '/three.png', candidateIndex: 0 }, _preserveGeneratorStack: false });
    assert.deepEqual(node.resultItems.map(item => item.candidateIndex), [4, 2, 0]);
    assert.equal(node.preserveGeneratorStack, true);
    assert.equal(node.runStatus, 'running');
});

for (const kind of ['image', 'video']) {
    test(`${kind} first preview follows renderer natural/pixel/display size priority and minimum edge`, () => {
        for (const [item, dimensions] of [
            [{ naturalWidth: 1800, naturalHeight: 900, pixelWidth: 900, pixelHeight: 1800, width: 100, height: 100 }, [1800, 900]],
            [{ pixelWidth: 900, pixelHeight: 1800, width: 100, height: 100 }, [900, 1800]],
            [{ width: 2400, height: 100 }, [2400, 100]]
        ]) {
            const node = source(kind);
            applyGeneratorStackResult(node, { _resultFilePath: '/one.png', _resultItem: item });
            const size = getGeneratorPlaceholderSize(kind, { ratio: 'adaptive' }, { width: dimensions[0], height: dimensions[1] });
            assert.deepEqual([node.width, node.height], [size.width, size.height]);
            applyGeneratorStackResult(node, { _resultFilePath: '/two.png', _resultItem: { width: 500, height: 500 }, _forceSquarePreview: true });
            assert.deepEqual([node.width, node.height], [size.width, size.height]);
        }
    });

    test(`${kind} unknown dimensions stay unchanged; forced square uses the renderer image preview size`, () => {
        const node = source(kind);
        applyGeneratorStackResult(node, { _resultFilePath: '/one.png' });
        assert.deepEqual([node.width, node.height], [400, 300]);
        applyGeneratorStackResult(node, { _resultFilePath: '/one.png', _forceSquarePreview: true });
        assert.deepEqual([node.width, node.height], [264, 264]);
    });
}
