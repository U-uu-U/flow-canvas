const test = require('node:test');
const assert = require('node:assert/strict');
const {
    BOARD_TRANSACTION_MCP_TOOLS,
    MCP_BOARD_TOOLS_VERSION,
    normalizeMcpConfig
} = require('./plan-service-core.cjs');

test('legacy custom MCP allowlists receive board transaction tools once', () => {
    const migrated = normalizeMcpConfig({
        allowedTools: ['flow_canvas.plan.list']
    });
    assert.equal(migrated.boardToolsVersion, MCP_BOARD_TOOLS_VERSION);
    assert.ok(migrated.allowedTools.includes('flow_canvas.plan.list'));
    BOARD_TRANSACTION_MCP_TOOLS.forEach(toolName => {
        assert.ok(migrated.allowedTools.includes(toolName));
    });
});

test('versioned MCP allowlists preserve later manual tool removals', () => {
    const configured = normalizeMcpConfig({
        boardToolsVersion: MCP_BOARD_TOOLS_VERSION,
        allowedTools: ['flow_canvas.board.get_snapshot']
    });
    assert.deepEqual(configured.allowedTools, ['flow_canvas.board.get_snapshot']);
});
