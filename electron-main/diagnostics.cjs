const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PRIVATE_KEY = /^(apiKey|authorization|cookie|set-cookie|password|secret|token|headers|env|prompt|messages|content|buffer|b64_json|sourcePaths|filePath|filePaths)$/i;
function sanitize(value, secrets = [], seen = new WeakSet(), depth = 0) {
    if (depth > 8) return '[Depth limit]';
    if (typeof value === 'string') {
        let text = value;
        for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[REDACTED]');
        return text.replace(/(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[AUTH REDACTED]')
            .replace(/\bsk-[A-Za-z0-9_-]+/g, '[KEY REDACTED]')
            .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*["']?)[^\s,"';&}]+/gi, '$1[REDACTED]')
            .replace(/https?:\/\/[^\s<>"')]+/gi, raw => {
                try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return '[URL]'; }
            })
            .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/gi, '[MEDIA REDACTED]')
            .slice(0, 6000);
    }
    if (value instanceof Error) return sanitize({ name: value.name, code: value.code, message: value.message, stack: value.stack }, secrets, seen, depth + 1);
    if (!value || typeof value !== 'object') return value;
    if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 2000).map(item => sanitize(item, secrets, seen, depth + 1));
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, entry]) =>
        [key, PRIVATE_KEY.test(key) ? '[REDACTED]' : sanitize(entry, secrets, seen, depth + 1)]));
}

class DiagnosticLog {
    constructor(directory, { maxBytes = 2 * 1024 * 1024, files = 3, getSecrets = () => [] } = {}) {
        this.directory = directory;
        this.maxBytes = maxBytes;
        this.files = files;
        this.getSecrets = getSecrets;
        this.sessionId = crypto.randomUUID();
        this.pending = [];
        this.timer = null;
        this.dropped = 0;
        this.writeError = null;
        this.sequence = 0;
    }
    clean(value) {
        let secrets = [];
        try { secrets = this.getSecrets() || []; } catch { /* Diagnostics must not break the application. */ }
        return sanitize(value, secrets);
    }
    record(level, event, data = {}) {
        if (this.recording) { this.dropped++; return; }
        this.recording = true;
        try {
            if (this.pending.length >= 1000) { this.dropped++; return; }
            const entry = { time: new Date().toISOString(), sessionId: this.sessionId,
                sequence: ++this.sequence, level, event, data: this.clean(data) };
            let line = JSON.stringify(entry);
            if (Buffer.byteLength(line) > 32768) line = JSON.stringify({ ...entry,
                data: { truncated: true, preview: JSON.stringify(entry.data).slice(0, 4000) } });
            if (Buffer.byteLength(line) + 1 > this.maxBytes) { this.dropped++; return; }
            this.pending.push(line);
            if (!this.timer) { this.timer = setTimeout(() => this.flush(), 1000); this.timer.unref?.(); }
        } catch { this.dropped++; }
        finally { this.recording = false; }
    }
    flush() {
        clearTimeout(this.timer); this.timer = null;
        if (!this.pending.length) return;
        const lines = this.pending.splice(0);
        try {
            fs.mkdirSync(this.directory, { recursive: true });
            const file = path.join(this.directory, 'events.jsonl');
            for (const line of lines) {
                const bytes = Buffer.byteLength(line) + 1;
                if (fs.existsSync(file) && fs.statSync(file).size + bytes > this.maxBytes) {
                    for (let i = this.files - 1; i >= 1; i--) {
                        const to = `${file}.${i}`, from = i === 1 ? file : `${file}.${i - 1}`;
                        if (fs.existsSync(to)) fs.unlinkSync(to);
                        if (fs.existsSync(from)) fs.renameSync(from, to);
                    }
                }
                fs.appendFileSync(file, `${line}\n`);
            }
            this.writeError = null;
        } catch (error) { this.writeError = error.code || 'LOG_WRITE_FAILED'; this.dropped += lines.length; }
    }
    read(limit = 1500) {
        this.flush();
        const events = [];
        for (let i = this.files - 1; i >= 0; i--) {
            try {
                const file = path.join(this.directory, `events.jsonl${i ? `.${i}` : ''}`);
                for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
                    try { if (line) events.push(JSON.parse(line)); } catch { /* Preserve other intact records. */ }
                }
            } catch { /* First run or rotated file. */ }
        }
        return this.clean(events.slice(-limit));
    }
}

let active = null;
function setDiagnosticLog(log) { active = log; }
function diagnostic(level, event, data) { active?.record(level, event, data); }
module.exports = { DiagnosticLog, sanitize, setDiagnosticLog, diagnostic };
