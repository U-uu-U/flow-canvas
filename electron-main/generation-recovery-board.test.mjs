import test from 'node:test';
import assert from 'node:assert/strict';
import { installGenerationRecoveryBoard } from './generation-recovery-board.mjs';
import { AgentBoardService } from './agent-board-service.mjs';

function setup() {
    const node = { id: 'node', kind: 'op', nodeType: 'image', config: { prompt: 'original' }, width: 400, height: 300, x: 10, y: 10 };
    let state = { activeGroupId: 'other', items: [], connections: [],
        folderGroups: [{ id: 'original', savedItems: [node], connections: [] }, { id: 'other', savedItems: [], connections: [] }] };
    const board = new AgentBoardService({ store: { load: () => structuredClone(state), save: value => { state = value; return true; } } });
    const bridge = {};
    installGenerationRecoveryBoard(bridge, board);
    const request = { kind: 'image', clientTaskId: 'local', taskId: 'remote', nodeId: 'node', projectId: 'original',
        prompt: 'original', providerConfig: { model: 'mj', id: 'api' } };
    request.targetSignature = bridge.captureRecoveryTarget(request);
    return { bridge, board, request, result: { taskId: 'remote', filePath: '/one.png', filePaths: ['/one.png', '/two.png', '/three.png', '/four.png'] } };
}

test('restores all results to original project/node with fixed dimensions and no duplicate stack', async () => {
    const { bridge, board, request, result } = setup();
    await bridge.attachRecoveredGeneration(request, result);
    await bridge.attachRecoveredGeneration(request, result);
    const original = board.readProject('original');
    assert.equal(original.items.length, 1);
    assert.equal(original.items[0].resultEntries.length, 4);
    assert.equal(original.items[0].width, 400);
    assert.equal(original.items[0].height, 300);
    assert.equal(original.items[0].runStatus, 'done');
    assert.equal(board.readProject('other').items.length, 0);
});

test('manual edits during query cause a conflict without overwriting the user', async () => {
    const { bridge, board, request, result } = setup();
    await board.updateProject('original', project => { project.items[0].config.prompt = 'new edit'; });
    await assert.rejects(bridge.attachRecoveredGeneration(request, result), /被修改/);
    assert.equal(board.readProject('original').items[0].config.prompt, 'new edit');
    assert.equal(board.readProject('original').items[0].filePath, undefined);
});

test('repeated recovery does not reset a result stack that the user has cycled', async () => {
    const { bridge, board, request, result } = setup();
    await bridge.attachRecoveredGeneration(request, result);
    await board.updateProject('original', project => { project.items[0].filePath = '/two.png'; project.items[0].resultStackPosition = 1; });
    await bridge.attachRecoveredGeneration(request, result);
    assert.equal(board.readProject('original').items[0].filePath, '/two.png');
    assert.equal(board.readProject('original').items[0].resultStackPosition, 1);
});

test('removed original node is restored separately on next explicit recovery, never in active project', async () => {
    const { bridge, board, request, result } = setup();
    await board.updateProject('original', project => { project.items = []; });
    await assert.rejects(bridge.attachRecoveredGeneration(request, result), /被修改/);
    request.targetSignature = bridge.captureRecoveryTarget(request);
    await bridge.attachRecoveredGeneration(request, result);
    assert.equal(board.readProject('original').items.length, 1);
    assert.equal(board.readProject('other').items.length, 0);
});
