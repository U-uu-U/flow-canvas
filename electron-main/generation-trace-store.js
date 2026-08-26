const fs = require('fs');
const path = require('path');

const TRACE_FILE_LIMIT = 200;

function safeTraceId(value) {
    const normalized = String(value || '')
        .trim()
        .replace(/[^a-z0-9._-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
    return normalized || `trace-${Date.now().toString(36)}`;
}

function redactSecrets(value, seen = new WeakSet()) {
    if (Array.isArray(value)) return value.map(entry => redactSecrets(entry, seen));
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (/^(?:apiKey|authorization|accessToken|refreshToken|secret)$/i.test(key)) {
            result[key] = '[REDACTED]';
        } else {
            result[key] = redactSecrets(entry, seen);
        }
    }
    seen.delete(value);
    return result;
}

async function pruneTraceFiles(traceDir, limit = TRACE_FILE_LIMIT) {
    const names = await fs.promises.readdir(traceDir).catch(() => []);
    const entries = await Promise.all(names
        .filter(name => name.endsWith('.json'))
        .map(async name => {
            const filePath = path.join(traceDir, name);
            const stat = await fs.promises.stat(filePath).catch(() => null);
            return stat?.isFile() ? { filePath, mtimeMs: stat.mtimeMs } : null;
        }));
    const stale = entries
        .filter(Boolean)
        .sort((left, right) => right.mtimeMs - left.mtimeMs)
        .slice(Math.max(1, Number(limit) || TRACE_FILE_LIMIT));
    await Promise.all(stale.map(entry => fs.promises.unlink(entry.filePath).catch(() => {})));
}

async function saveGenerationTrace(traceDir, trace, options = {}) {
    if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
        throw new Error('Generation Trace 必须是 JSON 对象');
    }
    await fs.promises.mkdir(traceDir, { recursive: true });
    const traceId = safeTraceId(trace.traceId);
    const filePath = path.join(traceDir, `${traceId}.json`);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const sanitized = redactSecrets({ ...trace, traceId });
    await fs.promises.writeFile(tempPath, JSON.stringify(sanitized, null, 2), 'utf8');
    await fs.promises.rename(tempPath, filePath);
    await pruneTraceFiles(traceDir, options.limit);
    return { traceId, filePath };
}

module.exports = {
    TRACE_FILE_LIMIT,
    safeTraceId,
    redactSecrets,
    pruneTraceFiles,
    saveGenerationTrace
};
