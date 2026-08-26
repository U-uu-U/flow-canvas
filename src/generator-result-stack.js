function normalizePath(value) {
    return String(value || '')
        .trim()
        .replace(/^local-res:\/\//i, '')
        .replace(/\\/g, '/')
        .toLowerCase();
}

function normalizeEntry(entry = {}) {
    const item = entry.item && typeof entry.item === 'object' ? entry.item : null;
    const filePath = entry.filePath || item?.filePath || '';
    const url = entry.url || item?.url || '';
    if (!filePath && !url && !item) return null;
    return { filePath, url, item };
}

function normalizePosition(value, count) {
    if (count <= 0) return 0;
    const position = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
    return ((position % count) + count) % count;
}

function legacyEntries(data = {}) {
    const paths = Array.isArray(data.resultFilePaths) ? data.resultFilePaths : [];
    const urls = Array.isArray(data.resultUrls) ? data.resultUrls : [];
    const items = Array.isArray(data.resultItems) ? data.resultItems : [];
    const count = Math.max(paths.length, urls.length, items.length);
    const entries = [];

    for (let index = 0; index < count; index += 1) {
        const entry = normalizeEntry({
            filePath: paths[index] || '',
            url: urls[index] || '',
            item: items[index] || null
        });
        if (entry) entries.push(entry);
    }
    return entries;
}

export function getGeneratorResultEntries(data = {}) {
    const current = Array.isArray(data.resultEntries)
        ? data.resultEntries.map(normalizeEntry).filter(Boolean)
        : [];
    return current.length > 0 ? current : legacyEntries(data);
}

export function setGeneratorResultEntries(data, entries = []) {
    const normalized = entries.map(normalizeEntry).filter(Boolean);
    data.resultEntries = normalized;
    data.resultFilePaths = normalized.map(entry => entry.filePath).filter(Boolean);
    data.resultUrls = normalized.map(entry => entry.url).filter(Boolean);
    data.resultItems = normalized.map(entry => entry.item).filter(Boolean);
    data.resultStackPosition = normalizePosition(data.resultStackPosition, normalized.length);
    return normalized;
}

export function ensureGeneratorResultEntries(data) {
    return setGeneratorResultEntries(data, getGeneratorResultEntries(data));
}

export function appendGeneratorResult(data, entry) {
    const normalized = normalizeEntry(entry);
    const entries = getGeneratorResultEntries(data);
    if (!normalized) return setGeneratorResultEntries(data, entries);

    const pathKey = normalizePath(normalized.filePath);
    const existingIndex = entries.findIndex(candidate => {
        const candidatePath = normalizePath(candidate.filePath);
        return (pathKey && candidatePath === pathKey)
            || (normalized.url && candidate.url === normalized.url);
    });
    if (existingIndex >= 0) {
        entries[existingIndex] = {
            filePath: normalized.filePath || entries[existingIndex].filePath,
            url: normalized.url || entries[existingIndex].url,
            item: normalized.item || entries[existingIndex].item
        };
    } else {
        entries.push(normalized);
    }
    return setGeneratorResultEntries(data, entries);
}

export function rotateGeneratorResults(data) {
    const entries = getGeneratorResultEntries(data);
    if (entries.length > 1) {
        entries.push(entries.shift());
        data.resultStackPosition = normalizePosition(data.resultStackPosition, entries.length) + 1;
    }
    const results = setGeneratorResultEntries(data, entries);
    data.resultStackPosition = normalizePosition(data.resultStackPosition, results.length);
    return results;
}

export function removeGeneratorResultByFilePath(data, filePath) {
    const target = normalizePath(filePath);
    if (!target) return { changed: false, entries: ensureGeneratorResultEntries(data) };
    const previous = getGeneratorResultEntries(data);
    const entries = previous.filter(entry => {
        const entryPath = normalizePath(entry.filePath || entry.item?.filePath);
        return !entryPath || entryPath !== target;
    });
    setGeneratorResultEntries(data, entries);
    if (entries.length !== previous.length) data.resultStackPosition = 0;
    return { changed: entries.length !== previous.length, entries };
}

export function clearGeneratorResults(data) {
    const results = setGeneratorResultEntries(data, []);
    data.resultStackPosition = 0;
    return results;
}

export function keepFirstGeneratorResult(data) {
    const first = getGeneratorResultEntries(data)[0] || null;
    const results = setGeneratorResultEntries(data, first ? [first] : []);
    data.resultStackPosition = 0;
    return results;
}
