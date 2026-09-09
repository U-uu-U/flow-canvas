const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class GenerationRecoveryStore {
    constructor(directory) {
        this.directory = directory;
        this.records = new Map();
        if (!directory) return;
        fs.mkdirSync(directory, { recursive: true });
        for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
            try {
                const entry = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
                if (entry.clientTaskId) this.records.set(entry.clientTaskId, entry);
            } catch { /* Keep damaged files for inspection; do not overwrite them on startup. */ }
        }
    }

    update(clientTaskId, patch) {
        if (!clientTaskId) return null;
        const entry = { ...this.records.get(clientTaskId), ...patch, clientTaskId, updatedAt: new Date().toISOString() };
        if (this.directory) {
            const name = crypto.createHash('sha256').update(clientTaskId).digest('hex');
            const file = path.join(this.directory, `${name}.json`);
            fs.writeFileSync(`${file}.tmp`, JSON.stringify(entry));
            fs.renameSync(`${file}.tmp`, file);
        }
        this.records.set(clientTaskId, entry);
        return entry;
    }

    get(clientTaskId) { return this.records.get(clientTaskId) || null; }

    find({ clientTaskId, taskId, kind, endpoint }) {
        const direct = this.get(clientTaskId);
        if (direct && (!taskId || direct.taskId === taskId)) return direct;
        return [...this.records.values()].find(entry => entry.taskId === taskId
            && entry.kind === kind && entry.endpoint === endpoint) || null;
    }

    list() {
        return [...this.records.values()].map(({ result, location, ...entry }) => ({
            ...entry, filePath: result?.filePath || null, filePaths: result?.filePaths || [],
            mediaType: result?.mediaType || entry.kind
        }));
    }
}

module.exports = { GenerationRecoveryStore };
