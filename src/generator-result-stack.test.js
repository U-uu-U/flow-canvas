import test from 'node:test';
import assert from 'node:assert/strict';
import {
    appendGeneratorResult,
    clearGeneratorResults,
    ensureGeneratorResultEntries,
    keepFirstGeneratorResult,
    removeGeneratorResultByFilePath,
    rotateGeneratorResults
} from './generator-result-stack.js';

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
