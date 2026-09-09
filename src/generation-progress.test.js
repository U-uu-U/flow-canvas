import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGenerationElapsed, isGenerationRecoveryActive, canRecoverGenerationTask } from './generation-progress.js';

test('elapsed time handles minutes, hours, future and invalid timestamps', () => {
    assert.equal(formatGenerationElapsed(1000, 1000), '00:00');
    assert.equal(formatGenerationElapsed(1000, 62999), '01:01');
    assert.equal(formatGenerationElapsed(1000, 3662000), '1:01:01');
    assert.equal(formatGenerationElapsed(2000, 1000), '00:00');
    assert.equal(formatGenerationElapsed(undefined, 90000), '00:00');
});

test('recovery stays active through queue, generation, and download, but not after cancel', () => {
    for (const syncStage of ['recovering', 'queued', 'processing', 'download', 'completed']) {
        assert.equal(isGenerationRecoveryActive({ status: 'running', params: { syncStage, recoveryStartedAt: 1000 } }), true);
    }
    for (const status of ['failed', 'disconnected', 'canceled', 'success']) {
        assert.equal(isGenerationRecoveryActive({ status, params: { recoveryStartedAt: 1000 } }), false);
    }
    assert.equal(isGenerationRecoveryActive({ status: 'running', params: { syncStage: 'processing' } }), false);
});

test('image and video recovery can use either a remote task ID or a downloaded checkpoint', () => {
    for (const kind of ['image', 'video']) {
        assert.equal(canRecoverGenerationTask({ kind, taskId: 'remote' }), true);
        assert.equal(canRecoverGenerationTask({ kind, filePath: 'output.png' }), true);
        assert.equal(canRecoverGenerationTask({ kind }), false);
    }
});
