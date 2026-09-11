function referenceLabelNumber(label) {
    const value = String(label || '').trim();
    const chineseNumerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    const chineseIndex = chineseNumerals.findIndex(numeral => value === `图${numeral}`);
    if (chineseIndex >= 0) return chineseIndex + 1;
    const numeric = Number(value.match(/^图(\d+)$/)?.[1]);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function restoreReferenceCitations(prompt, config = {}) {
    const text = String(prompt || '');
    const ids = Array.isArray(config.referenceCitationIds) ? config.referenceCitationIds : [];
    const labels = Array.isArray(config.referenceCitationLabels) ? config.referenceCitationLabels : [];
    const offsets = config.referenceCitationOffsets && typeof config.referenceCitationOffsets === 'object'
        ? config.referenceCitationOffsets
        : {};
    const occurrences = Array.isArray(config.referenceCitationOccurrences)
        ? config.referenceCitationOccurrences
        : ids.map(id => ({ connectionId: id, offset: offsets[id] }));
    const insertions = occurrences.map((entry, index) => ({
        index,
        label: String(labels[ids.indexOf(entry.connectionId)] || '').trim(),
        offset: Number(entry.offset)
    })).filter(entry => entry.label && Number.isFinite(entry.offset) && entry.offset >= 0 && entry.offset <= text.length);

    let restored = text;
    insertions
        .sort((left, right) => right.offset - left.offset || right.index - left.index)
        .forEach(entry => {
            restored = `${restored.slice(0, entry.offset)}${entry.label}${restored.slice(entry.offset)}`;
        });
    return restored;
}

export function referenceCitationGuide(config = {}) {
    const labels = Array.isArray(config.referenceCitationLabels)
        ? config.referenceCitationLabels.filter(label => typeof label === 'string' && label.trim())
        : [];
    const mappings = [...new Set(labels)].map(label => {
        const normalized = label.trim();
        const position = referenceLabelNumber(normalized);
        return position ? `${normalized}=第${position}张` : normalized;
    });
    return mappings.length ? `参考图编号与上传顺序一致：${mappings.join('，')}。` : '';
}

export function withoutReferenceCitationGuide(prompt, config = {}) {
    const guide = referenceCitationGuide(config);
    const text = String(prompt || '');
    return guide && text.startsWith(`${guide}\n`) ? text.slice(guide.length + 1) : text;
}

export function reusablePromptConfig(record = {}) {
    const config = JSON.parse(JSON.stringify(record.promptDraftConfig || record.config || {}));
    if (record.promptDraftConfig) return config;
    // Only remove our exact generated prefix from old records, never similar user prose.
    let prompt = String(record.prompt ?? record.requestPrompt ?? config.prompt ?? '');
    let next = withoutReferenceCitationGuide(prompt, config);
    while (next !== prompt) {
        prompt = next;
        next = withoutReferenceCitationGuide(prompt, config);
    }
    config.prompt = prompt;
    // Expanded text has already materialized citations; legacy offsets cannot be reapplied.
    for (const key of ['referenceCitationIds', 'referenceCitationLabels', 'referenceCitationOffsets', 'referenceCitationOccurrences']) {
        if (Object.hasOwn(config, key)) config[key] = key.endsWith('Offsets') ? {} : [];
    }
    return config;
}

export function bindReferenceCitations(config, references, context = []) {
    const snapshot = JSON.parse(JSON.stringify(config || {}));
    const ids = snapshot.referenceCitationIds || [];
    const labels = snapshot.referenceCitationLabels || [];
    const occurrences = snapshot.referenceCitationOccurrences || [];
    if (occurrences.some(entry => entry?.missing)) throw new Error('引用素材已失联，请重新连接素材或移除失联胶囊');
    const bindings = ids.map((connectionId, index) => {
        const occurrence = occurrences.find(entry => entry.connectionId === connectionId);
        const source = context.find(entry => occurrence?.sourceNodeId
            ? entry.sourceNodeId === occurrence.sourceNodeId || entry.source?.id === occurrence.sourceNodeId
            : entry.connectionId === connectionId);
        let position = source ? references.findIndex(ref => sourceFilePaths(source).includes(ref.filePath)) + 1 : 0;
        if (!position && !context.length && !occurrence?.sourceNodeId) position = referenceLabelNumber(labels[index]);
        if (!position || position > references.length) throw new Error('引用素材与上传列表不一致，请重新连接素材');
        const label = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][position - 1] || position;
        return { connectionId, sourceNodeId: occurrence?.sourceNodeId || source?.sourceNodeId || source?.source?.id || null,
            filePath: references[position - 1].filePath, position, label: `图${label}` };
    });
    if (ids.length) {
        snapshot.referenceCitationLabels = bindings.map(entry => entry.label);
        const savedOccurrences = Array.isArray(snapshot.referenceCitationOccurrences) ? occurrences
            : ids.map(connectionId => ({ connectionId, offset: snapshot.referenceCitationOffsets?.[connectionId] }));
        snapshot.referenceCitationOccurrences = savedOccurrences.map((entry, index) => ({
            ...entry, id: entry.id || `citation-${index}-${entry.connectionId}`,
            sourceNodeId: entry.sourceNodeId || bindings.find(binding => binding.connectionId === entry.connectionId)?.sourceNodeId
        }));
    }
    return { config: snapshot, bindings: references.map((reference, index) => {
        const sources = context.filter(entry => sourceFilePaths(entry).includes(reference.filePath));
        const source = sources[0];
        return { position: index + 1, filePath: reference.filePath,
            sourceNodeIds: [...new Set(sources.map(entry => entry.sourceNodeId || entry.source?.id).filter(Boolean))],
            sourceNodeId: source?.sourceNodeId || source?.source?.id || null,
            ...bindings.find(binding => binding.position === index + 1) };
    }) };
}

function sourceFilePaths(entry) {
    return [entry.source?.filePath, ...(entry.values || []).filter(value => typeof value === 'string' && value.startsWith('local-res://'))
        .map(value => {
            try { return decodeURIComponent(value.slice('local-res://'.length)); }
            catch { return value.slice('local-res://'.length); }
        })].filter(Boolean);
}
