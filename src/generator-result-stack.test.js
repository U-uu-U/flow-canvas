import test from 'node:test';
import assert from 'node:assert/strict';
import {
    appendGeneratorResult,
    clearGeneratorResults,
    ensureGeneratorResultEntries,
    getGeneratorResultEntries,
    getGeneratorResultLayout,
    keepFirstGeneratorResult,
    promoteGeneratorResult,
    removeGeneratorResultByFilePath,
    replaceGeneratorResultFilePath,
    resolveGeneratorResultMediaType,
    rotateGeneratorResults,
    setGeneratorResultLayout
} from './generator-result-stack.js';

test('resolves generated videos before replacing the generator node', () => {
    assert.equal(resolveGeneratorResultMediaType({ _resultMediaType: 'video' }, 'C:/output/result.png'), 'video');
    assert.equal(resolveGeneratorResultMediaType({}, 'C:/output/result.mp4'), 'video');
    assert.equal(resolveGeneratorResultMediaType({}, 'C:/output/result.png'), 'image');
});

test('migrates legacy result arrays into aligned entries', () => {
    const data = {
        resultFilePaths: ['C:/output/a.png', 'C:/output/b.png'],
        resultUrls: ['https://example.test/a.png', 'https://example.test/b.png'],
        resultItems: [{ id: 'a' }, { id: 'b' }]
    };

    assert.deepEqual(ensureGeneratorResultEntries(data), [
        { filePath: 'C:/output/a.png', url: 'https://example.test/a.png', item: { id: 'a' } },
        { filePath: 'C:/output/b.png', url: 'https://example.test/b.png', item: { id: 'b' } }
    ]);
});

test('appends one logical result even when it has both a path and URL', () => {
    const data = {};
    appendGeneratorResult(data, {
        filePath: 'C:/output/a.png',
        url: 'https://example.test/a.png',
        item: { id: 'a' }
    });
    appendGeneratorResult(data, {
        filePath: 'c:\\output\\a.png',
        item: { id: 'updated' }
    });

    assert.equal(data.resultEntries.length, 1);
    assert.equal(data.resultEntries[0].item.id, 'updated');
    assert.deepEqual(data.resultFilePaths, ['c:\\output\\a.png']);
});

test('rotates the second result to the front and sends the first to the tail', () => {
    const data = {
        resultEntries: [
            { filePath: 'A.png' },
            { filePath: 'B.png' },
            { filePath: 'C.png' }
        ]
    };

    rotateGeneratorResults(data);
    assert.deepEqual(data.resultFilePaths, ['B.png', 'C.png', 'A.png']);
    assert.equal(data.resultStackPosition, 1);
    rotateGeneratorResults(data);
    assert.deepEqual(data.resultFilePaths, ['C.png', 'A.png', 'B.png']);
    assert.equal(data.resultStackPosition, 2);
    rotateGeneratorResults(data);
    assert.deepEqual(data.resultFilePaths, ['A.png', 'B.png', 'C.png']);
    assert.equal(data.resultStackPosition, 0);
});

test('branch layout persists and any candidate can become the first result', () => {
    const data = {
        resultEntries: [
            { filePath: 'A.png' },
            { filePath: 'B.png' },
            { filePath: 'C.png' },
            { filePath: 'D.png' }
        ]
    };

    assert.equal(getGeneratorResultLayout(data), 'collapsed');
    assert.equal(setGeneratorResultLayout(data, 'branched'), true);
    assert.equal(getGeneratorResultLayout(data), 'branched');
    promoteGeneratorResult(data, 2);
    assert.deepEqual(data.resultFilePaths, ['C.png', 'D.png', 'A.png', 'B.png']);
    assert.equal(data.resultStackPosition, 2);
});

test('splitting keeps the promoted candidate and leaves the other candidates for branches', () => {
    const data = {
        resultEntries: [
            { filePath: 'A.png', item: { candidateIndex: 1 } },
            { filePath: 'B.png', item: { candidateIndex: 2 } },
            { filePath: 'C.png', item: { candidateIndex: 3 } },
            { filePath: 'D.png', item: { candidateIndex: 4 } }
        ]
    };

    promoteGeneratorResult(data, 2);
    const branchCandidates = getGeneratorResultEntries(data).slice(1);
    keepFirstGeneratorResult(data);

    assert.deepEqual(data.resultFilePaths, ['C.png']);
    assert.deepEqual(branchCandidates.map(candidate => candidate.filePath), ['D.png', 'A.png', 'B.png']);
    assert.deepEqual(branchCandidates.map(candidate => candidate.item.candidateIndex), [4, 1, 2]);
});

test('removing a file updates the canonical queue and legacy count fields', () => {
    const data = {
        resultEntries: [
            { filePath: 'C:/output/a.png', url: 'https://example.test/a.png' },
            { filePath: 'C:/output/b.png', url: 'https://example.test/b.png' }
        ]
    };

    const result = removeGeneratorResultByFilePath(data, 'c:\\output\\a.png');
    assert.equal(result.changed, true);
    assert.equal(result.entries.length, 1);
    assert.deepEqual(data.resultFilePaths, ['C:/output/b.png']);
    assert.deepEqual(data.resultUrls, ['https://example.test/b.png']);
    assert.equal(data.resultStackPosition, 0);

    clearGeneratorResults(data);
    assert.deepEqual(data.resultEntries, []);
    assert.deepEqual(data.resultFilePaths, []);
    assert.deepEqual(data.resultUrls, []);
    assert.equal(data.resultStackPosition, 0);
});

test('copying a stacked generator keeps only the visible first result', () => {
    const data = {
        resultEntries: [
            { filePath: 'B.png', url: 'https://example.test/b.png', item: { id: 'b' } },
            { filePath: 'C.png', url: 'https://example.test/c.png', item: { id: 'c' } },
            { filePath: 'A.png', url: 'https://example.test/a.png', item: { id: 'a' } }
        ],
        resultStackPosition: 1
    };

    keepFirstGeneratorResult(data);
    assert.deepEqual(data.resultFilePaths, ['B.png']);
    assert.deepEqual(data.resultUrls, ['https://example.test/b.png']);
    assert.deepEqual(data.resultItems, [{ id: 'b' }]);
    assert.equal(data.resultStackPosition, 0);
});

test('replacing a result path preserves the stack and updates nested result metadata', () => {
    const data = {
        resultEntries: [
            { filePath: 'C:/output/a.png', item: { id: 'a', filePath: 'C:/output/a.png' } },
            { filePath: 'C:/output/b.png', item: { id: 'b', filePath: 'C:/output/b.png' } }
        ],
        resultStackPosition: 1
    };

    const result = replaceGeneratorResultFilePath(data, 'c:\\output\\a.png', 'D:/archive/a.png');

    assert.equal(result.changed, true);
    assert.deepEqual(data.resultFilePaths, ['D:/archive/a.png', 'C:/output/b.png']);
    assert.equal(data.resultEntries[0].item.filePath, 'D:/archive/a.png');
    assert.equal(data.resultStackPosition, 1);
});
