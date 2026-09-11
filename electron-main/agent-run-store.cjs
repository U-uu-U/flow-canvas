const fs = require('node:fs');
const path = require('node:path');

function redact(value) {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/^(apiKey|api_key|authorization|password|secret|accessToken|refreshToken|visionInputs)$/i.test(key))
        .map(([key, entry]) => [key, redact(entry)]));
    if (typeof value === 'string') return value.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[visual input]')
        .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[redacted]');
    return value;
}

class AgentRunStore {
    constructor(directory) { this.directory = directory; fs.mkdirSync(directory, { recursive: true }); }
    save(run) {
        if (!/^agent-[a-zA-Z0-9-]+$/.test(run.id)) throw new Error('Invalid Agent run id');
        const file = path.join(this.directory, `${run.id}.json`);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(redact(run)), { mode: 0o600 });
        fs.renameSync(tmp, file);
    }
    loadAll() {
        return fs.readdirSync(this.directory).filter(name => /^agent-[a-zA-Z0-9-]+\.json$/.test(name)).map(name => {
            try { return JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8')); } catch { return null; }
        }).filter(Boolean);
    }
}
module.exports = { AgentRunStore, redact };
