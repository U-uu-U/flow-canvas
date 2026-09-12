import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createValidator, structuralValidate } from './lib/validate.mjs';
import { normalizeLineEndings } from '../scripts/sync-model-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.join(HERE, 'schema', 'model-config.schema.json');
const SEED = path.join(HERE, 'seed', 'model-config.default.json');

test('configserver 自带的 schema 与种子配置和 shared/ 除 CRLF/LF 外逐字一致（防止手工副本漂移）', () => {
    const root = path.join(HERE, '..');
    assert.equal(
        normalizeLineEndings(fs.readFileSync(SCHEMA, 'utf8')),
        normalizeLineEndings(fs.readFileSync(path.join(root, 'shared', 'schemas', 'model-config.schema.json'), 'utf8'))
    );
    assert.equal(
        normalizeLineEndings(fs.readFileSync(SEED, 'utf8')),
        normalizeLineEndings(fs.readFileSync(path.join(root, 'shared', 'model-config.default.json'), 'utf8'))
    );
    // 顺带确认这份 schema 真的是「含 models 定义」的那一份，而不是被换成了别的文件
    const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
    assert.equal(schema.properties.models.type, 'array');
    assert.equal(schema.properties.models.items.$ref, '#/definitions/model');
});

test('装了 ajv 时走完整 schema 校验', async () => {
    const validator = await createValidator({ schemaPath: SCHEMA });
    assert.equal(validator.mode, 'schema', validator.note);

    const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
    assert.equal(validator.validate(JSON.stringify(seed)).ok, true);
    assert.equal(validator.validate(seed).ok, true);

    const missingModels = validator.validate({ schemaVersion: 1, models: [] });
    assert.equal(missingModels.ok, false);
    assert.match(missingModels.errors.join(' '), /models/);

    const badKind = validator.validate({ schemaVersion: 1, models: [{ id: 'a', kind: 'audio', match: { model: ['x'] } }] });
    assert.equal(badKind.ok, false);

    const badRange = validator.validate({
        schemaVersion: 1,
        models: [{ id: 'a', kind: 'video', match: { model: ['x'] }, options: { duration: { type: 'range' } } }]
    });
    assert.equal(badRange.ok, false);

    // 额外字段必须放行：服务端要能先于旧客户端加字段
    const extra = validator.validate({
        schemaVersion: 1,
        models: [{ id: 'a', kind: 'video', match: { model: ['x'] } }],
        future: { anything: true }
    });
    assert.equal(extra.ok, true);
});

test('坏 JSON 给出可读原因，不抛异常', async () => {
    const validator = await createValidator({ schemaPath: SCHEMA });
    const result = validator.validate('{ "schemaVersion": 1, ');
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /不是合法 JSON/);
    assert.equal(result.config, null);
});

test('没有 ajv/schema 时降级为结构校验，并如实报告模式', async () => {
    const validator = await createValidator({ schemaPath: path.join(HERE, 'schema', '不存在.json') });
    assert.equal(validator.mode, 'structural');
    assert.match(validator.note, /未找到 schema/);

    const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
    assert.equal(validator.validate(seed).ok, true);

    // 结构校验仍要挡住会让客户端出事的配置
    assert.equal(validator.validate({ schemaVersion: 2, models: [] }).ok, false);
    assert.equal(validator.validate({ schemaVersion: 1, models: [{ id: 'a', kind: 'video' }] }).ok, false);
});

test('结构校验覆盖客户端真正依赖的不变量', () => {
    const base = { schemaVersion: 1, models: [{ id: 'x', kind: 'video', match: { model: ['^x$'] } }] };
    assert.deepEqual(structuralValidate(base), { ok: true, errors: [] });

    const cases = [
        [{ ...base, schemaVersion: 2 }, /schemaVersion/],
        [{ schemaVersion: 1, models: [] }, /models 必须是非空数组/],
        [{ schemaVersion: 1, models: [{ id: 'x', kind: 'video', match: { model: ['('] } }] }, /不是合法正则/],
        [{ schemaVersion: 1, models: [{ id: 'x', kind: 'video', match: { model: [] } }] }, /match\.model/],
        [{ schemaVersion: 1, models: [base.models[0], base.models[0]] }, /id 重复/],
        [{ schemaVersion: 1, models: [{ id: 'x', kind: 'video', match: { model: ['x'] }, options: { n: { type: 'range', min: 'a', max: 3 } } }] }, /min\/max/],
        [{ schemaVersion: 1, models: [{ id: 'x', kind: 'video', match: { model: ['x'] }, capabilities: { face: true } }] }, /supported/]
    ];
    for (const [input, pattern] of cases) {
        const result = structuralValidate(input);
        assert.equal(result.ok, false, JSON.stringify(input));
        assert.match(result.errors.join(' '), pattern);
    }
});
