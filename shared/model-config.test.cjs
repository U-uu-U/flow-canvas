// 模型 CONFIG 的「真相链」守卫：
//   data/model-channels.source.csv → shared/model-config.default.json → src/model-config-default.js
// 任一环脱节都会在这里失败，避免出现「表更新了但 UI 还按旧限制拦人」这类静默漂移。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const JSON_PATH = path.join(root, 'shared', 'model-config.default.json');
const SCHEMA_PATH = path.join(root, 'shared', 'schemas', 'model-config.schema.json');
const MODULE_PATH = path.join(root, 'src', 'model-config-default.js');

const readConfig = () => JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

test('CSV 每一行都被默认 CONFIG 恰好一个条目覆盖，且 notes 逐字一致', async () => {
    const { readCsvRows, checkConfigAgainstCsv } = await import('../scripts/sync-model-config.mjs');
    const rows = readCsvRows();
    const config = readConfig();
    assert.equal(rows.length, 16, 'CSV 行数变化时必须同步确认 CONFIG');
    assert.deepEqual(checkConfigAgainstCsv({ rows, config }), []);
});

test('默认 CONFIG 通过 JSON Schema 校验', () => {
    const Ajv = require('ajv');
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const validate = new Ajv({ allErrors: true }).compile(schema);
    const valid = validate(readConfig());
    assert.equal(valid, true, JSON.stringify(validate.errors, null, 2));
});

test('schema 会拒绝结构性错误的 CONFIG', () => {
    const Ajv = require('ajv');
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const validate = new Ajv({ allErrors: true }).compile(schema);
    assert.equal(validate({ schemaVersion: 1 }), false, '缺少 models');
    assert.equal(validate({ models: [] }), false, '缺少 schemaVersion');
    assert.equal(validate({ schemaVersion: 1, models: [{ id: 'a', kind: 'audio', match: { model: ['x'] } }] }), false, 'kind 非法');
    assert.equal(validate({ schemaVersion: 1, models: [{ id: 'a', kind: 'video', match: { model: ['x'] }, options: { duration: { type: 'range' } } }] }), false, 'range 缺 min/max');
    // 额外字段必须放行，保证服务端可以先加字段而不被旧客户端拒绝
    assert.equal(validate({ schemaVersion: 1, models: [{ id: 'a', kind: 'video', match: { model: ['x'] } }], futureField: { anything: true } }), true);
});

test('src/model-config-default.js 与 JSON 完全一致（renderer 打包用的那份）', async () => {
    assert.ok(fs.existsSync(MODULE_PATH), '缺少生成的 src/model-config-default.js，请运行 sync-model-config.mjs --write');
    const module = await import('../src/model-config-default.js');
    assert.deepEqual(module.DEFAULT_MODEL_CONFIG, readConfig());
});

test('默认 CONFIG 的 refreshIntervalMs 是 1 小时，且不依赖远端即可给出 16 个模型', () => {
    const config = readConfig();
    assert.equal(config.refreshIntervalMs, 60 * 60 * 1000);
    assert.equal(config.models.length, 16);
    const kinds = config.models.reduce((acc, entry) => {
        acc[entry.kind] = (acc[entry.kind] || 0) + 1;
        return acc;
    }, {});
    assert.deepEqual(kinds, { image: 3, video: 11, text: 2 });
});
