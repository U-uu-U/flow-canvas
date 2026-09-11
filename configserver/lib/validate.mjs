// 配置校验：**复用客户端同一份 JSON Schema**，保证「服务端接受的」= 「客户端接受的」。
//
// schema 由 scripts/sync-model-config.mjs 从 shared/schemas/ 同步到 configserver/schema/，
// 并有测试断言两份文件逐字一致——不允许服务端自己维护一份会漂移的副本。
//
// ajv 是可选依赖：装了就做完整 schema 校验（推荐）；没装则降级为结构校验，并在日志与
// 管理面板上明确标注「降级模式」，避免把「没校验」误当成「校验通过」。
import fs from 'node:fs';

const KINDS = ['image', 'video', 'text'];

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 降级模式下的结构校验：只覆盖客户端真正会消费、且坏了会导致线上事故的不变量。
export function structuralValidate(config) {
    const errors = [];
    if (!isPlainObject(config)) return { ok: false, errors: ['配置必须是 JSON 对象'] };
    if (Number(config.schemaVersion) !== 1) errors.push(`schemaVersion 必须是 1（当前 ${JSON.stringify(config.schemaVersion)}）`);
    if (!Array.isArray(config.models) || !config.models.length) {
        errors.push('models 必须是非空数组');
        return { ok: errors.length === 0, errors };
    }
    const ids = new Set();
    config.models.forEach((entry, index) => {
        const where = `models[${index}]`;
        if (!isPlainObject(entry)) {
            errors.push(`${where} 必须是对象`);
            return;
        }
        if (typeof entry.id !== 'string' || !entry.id.trim()) errors.push(`${where}.id 缺失`);
        else if (ids.has(entry.id)) errors.push(`${where}.id 重复：${entry.id}`);
        else ids.add(entry.id);
        if (!KINDS.includes(entry.kind)) errors.push(`${where}.kind 必须是 image/video/text（当前 ${JSON.stringify(entry.kind)}）`);
        const sources = entry.match?.model;
        if (!Array.isArray(sources) || !sources.length) errors.push(`${where}.match.model 必须是非空字符串数组`);
        else {
            sources.forEach(source => {
                try {
                    new RegExp(String(source));
                } catch (error) {
                    errors.push(`${where}.match.model 不是合法正则 ${JSON.stringify(source)}：${error.message}`);
                }
            });
        }
        for (const [field, constraint] of Object.entries(isPlainObject(entry.options) ? entry.options : {})) {
            if (!isPlainObject(constraint) || typeof constraint.type !== 'string') {
                errors.push(`${where}.options.${field} 缺少 type`);
                continue;
            }
            if (constraint.type === 'enum' && !Array.isArray(constraint.values)) errors.push(`${where}.options.${field} 缺少 values`);
            if (constraint.type === 'range' && !(Number.isFinite(Number(constraint.min)) && Number.isFinite(Number(constraint.max)))) {
                errors.push(`${where}.options.${field} 的 min/max 必须是数字`);
            }
            if (constraint.type === 'tier' && !Array.isArray(constraint.values)) errors.push(`${where}.options.${field} 缺少 values`);
        }
        for (const [key, capability] of Object.entries(isPlainObject(entry.capabilities) ? entry.capabilities : {})) {
            if (!isPlainObject(capability) || typeof capability.supported !== 'boolean') {
                errors.push(`${where}.capabilities.${key} 必须是 { supported: boolean }`);
            }
        }
    });
    return { ok: errors.length === 0, errors };
}

/**
 * 创建校验器。返回的 validate 接受「JSON 文本或对象」，永远返回
 * { ok, errors, config, mode }，不抛异常（抛异常会把管理面板变成 500）。
 */
export async function createValidator({ schemaPath } = {}) {
    let validateSchema = null;
    let mode = 'structural';
    let schemaNote = '';
    if (schemaPath && fs.existsSync(schemaPath)) {
        try {
            const { default: Ajv } = await import('ajv');
            const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
            validateSchema = new Ajv({ allErrors: true }).compile(schema);
            mode = 'schema';
        } catch (error) {
            schemaNote = `ajv 或 schema 不可用（${error.message}），已降级为结构校验`;
        }
    } else {
        schemaNote = '未找到 schema 文件，已降级为结构校验';
    }

    function formatAjvError(error) {
        const where = (error.dataPath || '').replace(/^\//, '');
        return error.keyword === 'required'
            ? `${where || '根'}缺少必填字段 ${error.params?.missingProperty}`
            : `${where || '根'} ${error.message}`;
    }

    function validate(input) {
        let config;
        if (typeof input === 'string') {
            try {
                config = JSON.parse(input);
            } catch (error) {
                return { ok: false, errors: [`不是合法 JSON：${error.message}`], config: null, mode };
            }
        } else {
            config = input;
        }
        if (validateSchema) {
            if (validateSchema(config)) return { ok: true, errors: [], config, mode };
            return { ok: false, errors: (validateSchema.errors || []).map(formatAjvError), config: null, mode };
        }
        const structural = structuralValidate(config);
        return structural.ok
            ? { ok: true, errors: [], config, mode }
            : { ok: false, errors: structural.errors, config: null, mode };
    }

    return { validate, mode, note: schemaNote };
}
