// 版本仓库：artconfig 服务的唯一状态来源。
//
// 语义（对应需求）：
//   · 每次保存生成一个**文件名带时间戳**的新版本 → 老版本天然成为备份，永不覆盖；
//   · state.json 里只有一个指针 current → 指向客户端当前拉到的那个版本；
//   · 「一键应用老的」= 把指针挪回旧文件，不复制、不改写任何配置内容；
//   · 每次保存/应用/删除都写一条审计记录，运维能回答「谁在什么时候把哪个版本推上去了」。
//
// 全部写入都是「临时文件 + rename」：进程被杀不会留下半个 JSON，客户端不会读到截断内容。
import fs from 'node:fs';
import path from 'node:path';

// 版本文件名：20260911T230012-r7.json（同日同秒冲突时加 -01 后缀）
export const VERSION_FILE_PATTERN = /^\d{8}T\d{6}(?:-\d{2})?-r\d+\.json$/;

export function isVersionFileName(value) {
    return VERSION_FILE_PATTERN.test(String(value || ''));
}

export function formatTimestamp(date) {
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
        + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function writeFileAtomic(target, text) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, target);
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return null;
    }
}

const AUDIT_LIMIT = 300;

export function createConfigStore({ dataDir, seedPath = '', now = () => new Date(), logger = console } = {}) {
    if (!dataDir) throw new Error('createConfigStore 需要 dataDir');
    const configsDir = path.join(dataDir, 'configs');
    const statePath = path.join(dataDir, 'state.json');

    function readState() {
        const state = readJson(statePath);
        if (!state || typeof state !== 'object') return { current: '', appliedAt: '', audit: [] };
        return {
            current: typeof state.current === 'string' ? state.current : '',
            appliedAt: typeof state.appliedAt === 'string' ? state.appliedAt : '',
            audit: Array.isArray(state.audit) ? state.audit.slice(0, AUDIT_LIMIT) : []
        };
    }

    function writeState(state) {
        writeFileAtomic(statePath, `${JSON.stringify({ ...state, audit: state.audit.slice(0, AUDIT_LIMIT) }, null, 2)}\n`);
    }

    function audit(state, action, details) {
        state.audit.unshift({ at: now().toISOString(), action, ...details });
        return state;
    }

    function versionPath(name) {
        if (!isVersionFileName(name)) throw new Error(`非法的版本文件名：${name}`);
        return path.join(configsDir, name);
    }

    function listNames() {
        try {
            return fs.readdirSync(configsDir).filter(isVersionFileName).sort();
        } catch (_) {
            return [];
        }
    }

    function readConfigFile(name) {
        const filePath = versionPath(name);
        const text = fs.readFileSync(filePath, 'utf8');
        return { name, text, config: JSON.parse(text), mtimeMs: fs.statSync(filePath).mtimeMs };
    }

    function maxRevision() {
        let max = 0;
        for (const name of listNames()) {
            const match = /-r(\d+)\.json$/.exec(name);
            const revision = match ? Number(match[1]) : 0;
            if (Number.isFinite(revision) && revision > max) max = revision;
        }
        return max;
    }

    function nextVersionName(date, revision) {
        const stamp = formatTimestamp(date);
        for (let salt = 0; salt < 100; salt += 1) {
            const name = `${stamp}${salt ? `-${String(salt).padStart(2, '0')}` : ''}-r${revision}.json`;
            if (!fs.existsSync(versionPath(name))) return name;
        }
        throw new Error('同一秒内版本过多，请稍后重试');
    }

    // 首次启动（或 data 目录被清空）时把内置默认配置播种成 r0，保证 /config 永远有内容可发。
    function ensureSeed() {
        const state = readState();
        if (state.current && fs.existsSync(path.join(configsDir, state.current))) return { seeded: false, state };
        if (listNames().length) {
            const latest = listNames().at(-1);
            state.current = latest;
            state.appliedAt = now().toISOString();
            writeState(audit(state, 'repair', { name: latest, actor: 'server', reason: 'current 指针失效，回退到最新版本' }));
            logger.warn(`[configserver] state.current 失效，已回退到最新版本 ${latest}`);
            return { seeded: false, state };
        }
        if (!seedPath || !fs.existsSync(seedPath)) {
            logger.warn('[configserver] 仓库为空且没有可用的种子配置：/config 会返回 404，请先在 /admin 保存一个版本');
            return { seeded: false, state };
        }
        const config = readJson(seedPath);
        if (!config) {
            logger.warn(`[configserver] 种子配置无法解析：${seedPath}`);
            return { seeded: false, state };
        }
        const revision = Number.isFinite(Number(config.revision)) ? Number(config.revision) : 0;
        const name = nextVersionName(now(), revision);
        writeFileAtomic(versionPath(name), `${JSON.stringify(config, null, 2)}\n`);
        state.current = name;
        state.appliedAt = now().toISOString();
        writeState(audit(state, 'seed', { name, actor: 'server', reason: `来自 ${path.basename(seedPath)}` }));
        logger.log(`[configserver] 已用内置默认配置播种版本 ${name}`);
        return { seeded: true, state };
    }

    function list() {
        const state = readState();
        return listNames().reverse().map(name => {
            let config = null;
            let size = 0;
            try {
                const file = readConfigFile(name);
                config = file.config;
                size = Buffer.byteLength(file.text, 'utf8');
            } catch (_) {
                return { name, broken: true, revision: null, modelCount: 0, size: 0, current: name === state.current };
            }
            return {
                name,
                broken: false,
                revision: Number.isFinite(Number(config?.revision)) ? Number(config.revision) : null,
                updatedAt: typeof config?.updatedAt === 'string' ? config.updatedAt : '',
                source: typeof config?.source === 'string' ? config.source : '',
                modelCount: Array.isArray(config?.models) ? config.models.length : 0,
                size,
                mtimeMs: fs.statSync(versionPath(name)).mtimeMs,
                current: name === state.current
            };
        });
    }

    function current() {
        const state = readState();
        if (!state.current) return null;
        try {
            return { ...readConfigFile(state.current), appliedAt: state.appliedAt };
        } catch (_) {
            return null;
        }
    }

    /**
     * 保存一个新版本。
     * @param {object} config 已经过校验的配置对象
     * @param {{ actor?: string, apply?: boolean, note?: string, source?: string }} options
     *   revision / updatedAt / source 由服务端盖章，避免管理员手改导致客户端版本号混乱。
     */
    function save(config, { actor = 'admin', apply = true, note = '', source = 'server:artconfig.ravenhash.org' } = {}) {
        const date = now();
        const revision = maxRevision() + 1;
        const stamped = {
            ...config,
            schemaVersion: Number(config.schemaVersion) || 1,
            revision,
            updatedAt: date.toISOString(),
            source: source || `server:${date.toISOString()}`
        };
        const name = nextVersionName(date, revision);
        writeFileAtomic(versionPath(name), `${JSON.stringify(stamped, null, 2)}\n`);

        const state = readState();
        if (apply) {
            state.current = name;
            state.appliedAt = date.toISOString();
        }
        writeState(audit(state, apply ? 'save+apply' : 'save', { name, revision, actor, note }));
        return { name, revision, applied: apply, config: stamped };
    }

    // 「一键应用老的到现行」：只改指针，不碰文件内容。
    function apply(name, { actor = 'admin', note = '' } = {}) {
        const file = readConfigFile(name); // 顺带验证文件存在且是合法 JSON
        const state = readState();
        const previous = state.current;
        state.current = name;
        state.appliedAt = now().toISOString();
        writeState(audit(state, 'apply', { name, revision: file.config?.revision ?? null, actor, note, previous }));
        return { name, previous, revision: Number(file.config?.revision ?? 0) };
    }

    function remove(name, { actor = 'admin' } = {}) {
        const state = readState();
        if (name === state.current) throw new Error('不能删除当前正在生效的版本，请先切换到其它版本');
        const filePath = versionPath(name);
        if (!fs.existsSync(filePath)) throw new Error('版本不存在');
        fs.unlinkSync(filePath);
        writeState(audit(readState(), 'delete', { name, actor }));
        return { name };
    }

    function history(limit = 50) {
        return readState().audit.slice(0, limit);
    }

    return {
        dataDir,
        configsDir,
        statePath,
        ensureSeed,
        list,
        listNames,
        read: readConfigFile,
        current,
        save,
        apply,
        remove,
        history,
        readState
    };
}
