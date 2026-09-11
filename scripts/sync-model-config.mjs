// 模型能力 CONFIG 的同步/校验脚本。
//
//   node scripts/sync-model-config.mjs            # 校验（默认，CI/测试用）
//   node scripts/sync-model-config.mjs --write     # 由 JSON 重新生成 src/model-config-default.js
//   node scripts/sync-model-config.mjs --scaffold  # 为 CSV 里新增、但 JSON 还没收录的行打印骨架
//
// 数据流（单向，避免两套真相）：
//
//   shared/model-channels.source.csv ← 权威表格（渠道/模型/入参/限制与说明）
//   shared/model-config.default.json ← 人工结构化后的默认配置（唯一真相）
//   src/model-config-default.js      ← 由上面的 JSON 生成，供渲染层打包（--write）
//
// 源表放在 shared/ 而不是 data/：data/ 在 .gitignore 里（用户数据目录），
// 而这张表是构建/测试的输入，必须进版本库。
//
// 为什么是「校验」而不是「自动翻译」：CSV 的限制列是自然语言，早期版本尝试自动解析
// （单次1-8张、4-30秒整数、最多9张参考图……），结果在 11 条上解析错误或漏解析——
// 例如「自动/5/10/12秒」被解析成固定 12 秒、「480p/768p/1080p/2K/4K」丢掉 2K/4K。
// 猜错的边界比没有边界更危险：它会让 UI 放行一个上游必然拒绝的请求。所以结构化字段
// 一律人工确认，脚本只负责**强制**两件事：
//   1. CSV 的每一行都被 JSON 里恰好一个条目覆盖（新增一行必须有人做决定）；
//   2. JSON 条目里的 notes 与 CSV 的「限制与说明」逐字一致（说明改了必须同步）。
// 校验失败即退出码 1，因此可以安全地挂进测试与 CI。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSV_PATH = path.join(root, 'shared', 'model-channels.source.csv');
const JSON_PATH = path.join(root, 'shared', 'model-config.default.json');
const SCHEMA_PATH = path.join(root, 'shared', 'schemas', 'model-config.schema.json');
const MODULE_PATH = path.join(root, 'src', 'model-config-default.js');
// configserver 是独立部署的：它必须自带一份 schema（用 ajv 校验）和一份种子配置
// （首次启动播种 /config）。这两份由本脚本同步，并有测试断言逐字一致——服务端不允许
// 维护会漂移的手工副本。
const SERVER_SCHEMA_PATH = path.join(root, 'configserver', 'schema', 'model-config.schema.json');
const SERVER_SEED_PATH = path.join(root, 'configserver', 'seed', 'model-config.default.json');

// ── CSV 解析（引号包裹、引号内逗号与双写引号）─────────────────────
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"') { inQuotes = true; continue; }
        if (ch === ',') { row.push(field); field = ''; continue; }
        if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        if (ch === '\r') continue;
        field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(entry => entry.some(value => String(value).trim() !== ''));
}

export function readCsvRows(csvPath = CSV_PATH) {
    const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
    const header = rows.shift().map(value => value.trim());
    const column = (...names) => {
        for (const name of names) {
            const index = header.findIndex(value => value.includes(name));
            if (index >= 0) return index;
        }
        return -1;
    };
    const index = {
        channel: column('渠道'),
        route: column('上游', '线路'),
        model: column('模型'),
        params: column('入参'),
        limits: column('限制')
    };
    return rows.map((row, position) => ({
        position: position + 2, // CSV 行号（含表头，从 1 开始）
        channel: String(row[index.channel] || '').trim(),
        route: String(row[index.route] || '').trim(),
        modelCell: String(row[index.model] || '').trim(),
        params: String(row[index.params] || '').split(';').map(value => value.trim()).filter(Boolean),
        limits: String(row[index.limits] || '').trim()
    }));
}

const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
const aliasesOf = modelCell => normalize(modelCell).split('/').map(value => value.trim()).filter(Boolean);

export function compileMatchers(entry) {
    return (entry?.match?.model || []).map(source => {
        try {
            return new RegExp(source, 'i');
        } catch (_) {
            return null;
        }
    }).filter(Boolean);
}

// CSV 行 → CONFIG 条目：渠道相同、线路相同，且模型列里至少一个别名能被命中。
export function matchRowToEntry(row, entry) {
    if (normalize(entry.channel) !== normalize(row.channel)) return false;
    if (normalize(entry.route) !== normalize(row.route)) return false;
    const matchers = compileMatchers(entry);
    const label = normalize(entry.label);
    return aliasesOf(row.modelCell).some(alias => normalize(alias) === label
        || matchers.some(matcher => matcher.test(normalize(alias))));
}

// 校验 CSV 与 CONFIG 的一一对应关系。返回问题列表（空数组 = 通过）。
export function checkConfigAgainstCsv({ rows, config }) {
    const problems = [];
    const models = Array.isArray(config?.models) ? config.models : [];

    const seenIds = new Set();
    for (const entry of models) {
        if (seenIds.has(entry.id)) problems.push(`CONFIG 条目 id 重复：${entry.id}`);
        seenIds.add(entry.id);
        for (const source of entry?.match?.model || []) {
            try {
                new RegExp(source);
            } catch (error) {
                problems.push(`${entry.id}：match.model 不是合法正则 ${JSON.stringify(source)}（${error.message}）`);
            }
        }
        for (const key of Object.keys(entry?.options || {})) {
            const constraint = entry.options[key];
            if (constraint?.type === 'range' && !(constraint.min <= constraint.max)) {
                problems.push(`${entry.id}：options.${key} 的 min > max`);
            }
            if (constraint?.type === 'enum' && !Array.isArray(constraint.values)) {
                problems.push(`${entry.id}：options.${key} 缺少 values`);
            }
        }
    }

    const claimed = new Map(); // entry.id → CSV 行号
    for (const row of rows) {
        const matched = models.filter(entry => matchRowToEntry(row, entry));
        if (!matched.length) {
            problems.push(`CSV 第 ${row.position} 行未被 CONFIG 覆盖：${row.channel} / ${row.route} / ${row.modelCell}`);
            continue;
        }
        if (matched.length > 1) {
            problems.push(`CSV 第 ${row.position} 行命中多个 CONFIG 条目：${matched.map(entry => entry.id).join(', ')}`);
            continue;
        }
        const entry = matched[0];
        if (claimed.has(entry.id)) {
            problems.push(`CONFIG 条目 ${entry.id} 同时被 CSV 第 ${claimed.get(entry.id)} 行和第 ${row.position} 行命中`);
        }
        claimed.set(entry.id, row.position);
        if (normalize(entry.notes) !== normalize(row.limits)) {
            problems.push(`CONFIG 条目 ${entry.id} 的 notes 与 CSV 第 ${row.position} 行的「限制与说明」不一致\n    CSV : ${row.limits}\n    JSON: ${entry.notes}`);
        }
    }

    for (const entry of models) {
        if (!claimed.has(entry.id)) {
            problems.push(`CONFIG 条目 ${entry.id} 在 CSV 里没有对应行（若为手工补充的线路，请在 CSV 中登记）`);
        }
    }
    return problems;
}

// 为 CSV 里尚未收录的行打印骨架，人工补全后并入 JSON。
export function scaffoldEntry(row) {
    const firstAlias = aliasesOf(row.modelCell)[0] || row.modelCell;
    const slug = value => String(value || '').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
    const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
        id: `${slug(row.channel)}.${slug(firstAlias)}`,
        label: firstAlias,
        kind: /文字/.test(row.channel) ? 'text' : (/图片|midjourney/i.test(row.channel) ? 'image' : 'video'),
        channel: row.channel,
        route: row.route,
        priority: 50,
        match: { model: aliasesOf(row.modelCell).map(escapeRegExp) },
        parameters: { accepts: [...new Set(['model', ...row.params])] },
        options: {},
        capabilities: {},
        prompt: { required: row.params.includes('prompt') },
        notes: row.limits,
        _todo: '补全 options / capabilities / prompt.maxLength 后再并入 shared/model-config.default.json'
    };
}

// ── 生成渲染层默认配置模块 ────────────────────────────────────
export function renderDefaultModule(config) {
    return `// 本文件由 scripts/sync-model-config.mjs --write 从 shared/model-config.default.json 生成。
// 不要直接编辑：改 JSON（JSON 是唯一真相），然后运行：
//   node scripts/sync-model-config.mjs --write
//
// 为什么要生成一个 .js 而不是直接 import JSON：渲染层由 Vite 打包、测试由 node --test 直接跑，
// 两套环境对 JSON import attributes（with { type: 'json' }）的支持不一致。生成 ESM 模块后
// 两边都能直接 import，且 src/model-config-default.test.js 会断言它与 JSON 完全一致。
export const DEFAULT_MODEL_CONFIG = ${JSON.stringify(config, null, 4)};

export default DEFAULT_MODEL_CONFIG;
`;
}

function validateSchema(config) {
    let Ajv;
    try {
        Ajv = require('ajv');
    } catch (_) {
        return ['未安装 ajv，跳过 schema 校验'];
    }
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    if (validate(config)) return [];
    return (validate.errors || []).map(error => `schema ${error.dataPath || '/'} ${error.message}`);
}

function copiesToSync() {
    return [
        { source: SCHEMA_PATH, target: SERVER_SCHEMA_PATH, label: 'configserver schema' },
        { source: JSON_PATH, target: SERVER_SEED_PATH, label: 'configserver 种子配置' }
    ];
}

// 同步给 configserver 的两份副本（逐字节），返回是否有变化 / 是否漂移。
function syncServerCopies({ write }) {
    const changed = [];
    const drifted = [];
    for (const { source, target, label } of copiesToSync()) {
        const sourceText = fs.readFileSync(source, 'utf8');
        const targetText = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
        if (targetText === sourceText) continue;
        if (write) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, sourceText, 'utf8');
            changed.push(label);
        } else {
            drifted.push(`${label}（${path.relative(root, target)}）与 ${path.relative(root, source)} 不一致`);
        }
    }
    return { changed, drifted };
}

function main(argv) {
    const write = argv.includes('--write');
    const scaffold = argv.includes('--scaffold');
    const rows = readCsvRows();
    const config = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

    if (scaffold) {
        const uncovered = rows.filter(row => !config.models.some(entry => matchRowToEntry(row, entry)));
        if (!uncovered.length) {
            console.log('CSV 所有行都已被 CONFIG 覆盖，无需骨架。');
            return 0;
        }
        console.log(`以下 ${uncovered.length} 行尚未收录，骨架如下（补全后并入 JSON）：\n`);
        console.log(JSON.stringify(uncovered.map(scaffoldEntry), null, 4));
        return 0;
    }

    const problems = [...validateSchema(config), ...checkConfigAgainstCsv({ rows, config })];
    if (problems.length) {
        console.error(`模型 CONFIG 校验失败（${problems.length} 项）：`);
        for (const problem of problems) console.error(`  - ${problem}`);
        console.error('\n提示：node scripts/sync-model-config.mjs --scaffold 可打印缺失行的骨架。');
        return 1;
    }

    const rendered = renderDefaultModule(config);
    const current = fs.existsSync(MODULE_PATH) ? fs.readFileSync(MODULE_PATH, 'utf8') : '';
    if (write) {
        if (current !== rendered) {
            fs.writeFileSync(MODULE_PATH, rendered, 'utf8');
            console.log(`已生成 ${path.relative(root, MODULE_PATH)}`);
        } else {
            console.log(`${path.relative(root, MODULE_PATH)} 已是最新`);
        }
    } else if (current !== rendered) {
        console.error('src/model-config-default.js 与 shared/model-config.default.json 不一致。');
        console.error('请运行：node scripts/sync-model-config.mjs --write');
        return 1;
    }

    const server = syncServerCopies({ write });
    if (server.drifted.length) {
        console.error(`configserver 副本漂移（${server.drifted.length} 项）：`);
        for (const item of server.drifted) console.error(`  - ${item}`);
        console.error('请运行：node scripts/sync-model-config.mjs --write');
        return 1;
    }
    for (const label of server.changed) console.log(`已同步 ${label}`);

    const byKind = config.models.reduce((acc, entry) => {
        acc[entry.kind] = (acc[entry.kind] || 0) + 1;
        return acc;
    }, {});
    console.log(`模型 CONFIG 校验通过：${rows.length} 行 CSV，${config.models.length} 个条目`
        + `（${Object.entries(byKind).map(([kind, count]) => `${kind}=${count}`).join(', ')}）`);
    return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    process.exitCode = main(process.argv.slice(2));
}
