// 模型 CONFIG 的「真相链」守卫：
//   data/model-channels.source.csv → shared/model-config.default.json → src/model-config-default.js
// 任一环脱节都会在这里失败，避免出现「表更新了但 UI 还按旧限制拦人」这类静默漂移。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const JSON_PATH = path.join(root, 'shared', 'model-config.default.json');
const SCHEMA_PATH = path.join(root, 'shared', 'schemas', 'model-config.schema.json');
const MODULE_PATH = path.join(root, 'src', 'model-config-default.js');

const readConfig = () => JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

const sourceFiles = [
    'shared/model-channels.source.csv',
    'shared/model-config.default.json',
    'shared/schemas/model-config.schema.json'
];
const generatedFiles = [
    'src/model-config-default.js',
    'configserver/seed/model-config.default.json',
    'configserver/schema/model-config.schema.json'
];

function syncFixture(t, sourceEol = '\n', targetEol = '\n') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-model-config-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const files = ['scripts/sync-model-config.mjs', ...sourceFiles, ...generatedFiles];
    for (const file of files) {
        const target = path.join(directory, file);
        const eol = generatedFiles.includes(file) ? targetEol : sourceEol;
        const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, eol);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
    }
    return {
        file: relative => path.join(directory, relative),
        run: (...args) => spawnSync(process.execPath, ['scripts/sync-model-config.mjs', ...args], {
            cwd: directory,
            encoding: 'utf8',
            timeout: 15000,
            env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') }
        })
    };
}

test('line-ending normalization preserves all differences except CRLF versus LF', async () => {
    const { normalizeLineEndings } = await import('../scripts/sync-model-config.mjs');
    assert.equal(normalizeLineEndings('first\r\nsecond\n'), 'first\nsecond\n');
    for (const text of ['first \nsecond\n', 'first\nsecond', 'first\nchanged\n', 'first\rsecond\n', 'first\\r\\nsecond\n']) {
        assert.notEqual(normalizeLineEndings(text), normalizeLineEndings('first\r\nsecond\r\n'));
    }
});

for (const [sourceName, sourceEol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    for (const [targetName, targetEol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
        test(`sync accepts ${sourceName} sources and ${targetName} copies without rewriting them`, t => {
            const fixture = syncFixture(t, sourceEol, targetEol);
            const paths = [...sourceFiles, ...generatedFiles].map(fixture.file);
            const before = paths.map(file => fs.readFileSync(file));
            for (const args of [[], ['--write']]) {
                const result = fixture.run(...args);
                assert.ifError(result.error);
                assert.equal(result.status, 0, result.stderr);
                assert.deepEqual(paths.map(file => fs.readFileSync(file)), before);
            }
        });
    }
}

for (const file of generatedFiles) {
    for (const state of ['changed', 'missing']) {
        test(`sync detects and repairs ${state} ${file} using authoritative sources`, t => {
            const fixture = syncFixture(t, '\r\n', '\n');
            const target = fixture.file(file);
            const before = sourceFiles.map(file => fs.readFileSync(fixture.file(file)));
            const original = fs.readFileSync(target, 'utf8');
            if (state === 'missing') fs.unlinkSync(target);
            else fs.writeFileSync(target, original.replace('"schemaVersion"', '"schemaVersionDrift"'));
            const checked = fixture.run();
            assert.ifError(checked.error);
            assert.equal(checked.status, 1, checked.stdout);
            assert.ok(checked.stderr.includes(file.replaceAll('/', path.sep)) || checked.stderr.includes(file), checked.stderr);
            assert.equal(fs.existsSync(target), state === 'changed');
            if (state === 'changed') assert.equal(fs.readFileSync(target, 'utf8'), original.replace('"schemaVersion"', '"schemaVersionDrift"'));
            const written = fixture.run('--write');
            assert.ifError(written.error);
            assert.equal(written.status, 0, written.stderr);
            assert.equal(fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n'), original);
            assert.deepEqual(sourceFiles.map(file => fs.readFileSync(fixture.file(file))), before);
            const rechecked = fixture.run();
            assert.ifError(rechecked.error);
            assert.equal(rechecked.status, 0, rechecked.stderr);
        });
    }
}

test('CSV 每一行都被默认 CONFIG 恰好一个条目覆盖，且 notes 逐字一致', async () => {
    const { readCsvRows, checkConfigAgainstCsv } = await import('../scripts/sync-model-config.mjs');
    const rows = readCsvRows();
    const config = readConfig();
    assert.equal(rows.length, 15, 'CSV 行数变化时必须同步确认 CONFIG');
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

test('默认 CONFIG 的 refreshIntervalMs 是 1 小时，且不依赖远端即可给出 15 个模型', () => {
    const config = readConfig();
    assert.equal(config.refreshIntervalMs, 60 * 60 * 1000);
    assert.equal(config.models.length, 15);
    const kinds = config.models.reduce((acc, entry) => {
        acc[entry.kind] = (acc[entry.kind] || 0) + 1;
        return acc;
    }, {});
    assert.deepEqual(kinds, { image: 3, video: 10, text: 2 });
});
