const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { saveGenerationTrace } = require('./generation-trace-store');

test('saveGenerationTrace: 原子写入、清理旧记录并移除密钥', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-canvas-traces-'));
    try {
        for (let index = 1; index <= 3; index += 1) {
            await saveGenerationTrace(tempDir, {
                traceId: `trace-${index}`,
                planner: { apiKey: 'secret', model: 'gpt-5.5' },
                generation: { authorization: 'Bearer secret', status: 'success' }
            }, { limit: 2 });
            await new Promise(resolve => setTimeout(resolve, 5));
        }

        const names = fs.readdirSync(tempDir).filter(name => name.endsWith('.json'));
        assert.equal(names.length, 2);
        const latest = JSON.parse(fs.readFileSync(path.join(tempDir, 'trace-3.json'), 'utf8'));
        assert.equal(latest.planner.apiKey, '[REDACTED]');
        assert.equal(latest.generation.authorization, '[REDACTED]');
        assert.equal(fs.readdirSync(tempDir).some(name => name.endsWith('.tmp')), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
