const fs = require('fs');
const path = require('path');

const STORE_VERSION = 1;
const DEFAULT_BACKUP_LIMIT = 20;

function cloneJson(value, fallback) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return fallback;
    }
}

function normalizeConfig(config = {}) {
    const providers = Array.isArray(config.providers)
        ? cloneJson(config.providers.slice(0, 100), [])
        : [];
    const globalConfig = config.globalConfig && typeof config.globalConfig === 'object'
        ? cloneJson(config.globalConfig, {})
        : {};
    return {
        version: STORE_VERSION,
        revision: Math.max(0, Number(config.revision) || 0),
        updatedAt: typeof config.updatedAt === 'string' && config.updatedAt
            ? config.updatedAt
            : new Date().toISOString(),
        providers,
        globalConfig
    };
}

class ApiConfigStore {
    constructor(userDataPath, options = {}) {
        this.dataDir = path.join(userDataPath, 'data');
        this.filePath = path.join(this.dataDir, 'api-config.v1.json');
        this.backupDir = path.join(this.dataDir, 'api-config-backups');
        this.backupLimit = Math.max(1, Number(options.backupLimit) || DEFAULT_BACKUP_LIMIT);
        this.protect = typeof options.protect === 'function' ? options.protect : null;
        this.unprotect = typeof options.unprotect === 'function' ? options.unprotect : null;
        this.now = typeof options.now === 'function' ? options.now : () => new Date();
    }

    load() {
        const candidates = [this.filePath, ...this._backupFiles()];
        for (const candidate of candidates) {
            const config = this._readConfig(candidate);
            if (!config) continue;
            return {
                success: true,
                config,
                recoveredFromBackup: candidate !== this.filePath
            };
        }
        return { success: true, config: null, recoveredFromBackup: false };
    }

    save(config) {
        try {
            const normalized = normalizeConfig(config);
            const current = this._readConfig(this.filePath);
            if (current && JSON.stringify(current) === JSON.stringify(normalized)) {
                return { success: true, unchanged: true, revision: normalized.revision };
            }

            fs.mkdirSync(this.dataDir, { recursive: true });
            if (current && fs.existsSync(this.filePath)) this._backupPrimary();
            const envelope = this._encode(normalized);
            const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
            fs.writeFileSync(tempPath, JSON.stringify(envelope, null, 2), 'utf8');
            fs.renameSync(tempPath, this.filePath);
            this._pruneBackups();
            return { success: true, unchanged: false, revision: normalized.revision };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    }

    _encode(config) {
        const raw = JSON.stringify(config);
        if (this.protect) {
            const protectedValue = this.protect(raw);
            if (protectedValue) {
                const buffer = Buffer.isBuffer(protectedValue)
                    ? protectedValue
                    : Buffer.from(protectedValue);
                return {
                    version: STORE_VERSION,
                    format: 'safe-storage',
                    updatedAt: config.updatedAt,
                    payload: buffer.toString('base64')
                };
            }
        }
        return {
            version: STORE_VERSION,
            format: 'plain-json',
            updatedAt: config.updatedAt,
            payload: raw
        };
    }

    _decode(envelope) {
        if (!envelope || typeof envelope !== 'object') return null;
        let raw = '';
        if (envelope.format === 'safe-storage') {
            if (!this.unprotect || typeof envelope.payload !== 'string') return null;
            raw = this.unprotect(Buffer.from(envelope.payload, 'base64'));
        } else if (envelope.format === 'plain-json') {
            raw = envelope.payload;
        } else if (Array.isArray(envelope.providers)) {
            return normalizeConfig(envelope);
        }
        if (typeof raw !== 'string' || !raw) return null;
        return normalizeConfig(JSON.parse(raw));
    }

    _readConfig(filePath) {
        try {
            if (!fs.existsSync(filePath)) return null;
            return this._decode(JSON.parse(fs.readFileSync(filePath, 'utf8')));
        } catch (_) {
            return null;
        }
    }

    _backupPrimary() {
        fs.mkdirSync(this.backupDir, { recursive: true });
        const stamp = this.now().toISOString().replace(/[:.]/g, '-');
        let backupPath = path.join(this.backupDir, `api-config-${stamp}.json`);
        let suffix = 1;
        while (fs.existsSync(backupPath)) {
            backupPath = path.join(this.backupDir, `api-config-${stamp}-${suffix++}.json`);
        }
        fs.copyFileSync(this.filePath, backupPath);
    }

    _backupFiles() {
        try {
            if (!fs.existsSync(this.backupDir)) return [];
            return fs.readdirSync(this.backupDir)
                .filter(name => /^api-config-.*\.json$/i.test(name))
                .map(name => path.join(this.backupDir, name))
                .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        } catch (_) {
            return [];
        }
    }

    _pruneBackups() {
        this._backupFiles().slice(this.backupLimit).forEach(filePath => {
            try { fs.unlinkSync(filePath); } catch (_) { }
        });
    }
}

module.exports = { ApiConfigStore, normalizeConfig };
