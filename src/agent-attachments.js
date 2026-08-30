import { getGeneratorResultEntries, resolveGeneratorResultMediaType } from './generator-result-stack.js';

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'svg', 'ico', 'avif', 'heic', 'heif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', 'm4v', 'mpeg', 'mpg']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'aac', 'flac', 'ogg', 'wma', 'm4a']);

function dataForItem(item) {
    return item?.data && typeof item.data === 'object' ? item.data : item;
}

function extensionFromPath(filePath = '') {
    return String(filePath).split(/[?#]/, 1)[0].split('.').pop()?.toLowerCase() || '';
}

function mediaTypeForPath(filePath = '', fallback = '') {
    const normalizedFallback = String(fallback || '').toLowerCase();
    if (['image', 'video', 'audio'].includes(normalizedFallback)) return normalizedFallback;
    const extension = extensionFromPath(filePath);
    if (IMAGE_EXTENSIONS.has(extension)) return 'image';
    if (VIDEO_EXTENSIONS.has(extension)) return 'video';
    if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
    return null;
}

function displayName(filePath = '', url = '', fallback = '') {
    const value = String(filePath || url || '').replace(/\\/g, '/');
    const name = value.split('/').filter(Boolean).pop();
    try {
        return decodeURIComponent(name || '') || fallback;
    } catch (_) {
        return name || fallback;
    }
}

function attachmentKey(attachment) {
    const value = String(attachment.filePath || attachment.url || '').trim().replace(/\\/g, '/').toLowerCase();
    return value ? `${attachment.mediaType}:${value}` : '';
}

function attachmentsForItem(rawItem, depth) {
    const item = dataForItem(rawItem);
    if (!item) return [];
    const attachments = [];
    const append = ({ filePath = '', url = '', mediaType = '', width = null, height = null } = {}) => {
        const resolvedType = mediaTypeForPath(filePath || url, mediaType);
        if (!resolvedType || (!filePath && !url)) return;
        attachments.push({
            itemId: item.id || null,
            sourceNodeId: item.id || null,
            filePath: String(filePath || ''),
            url: String(url || ''),
            mediaType: resolvedType,
            name: displayName(filePath, url, item.title || `${resolvedType}素材`),
            width: Number(width) || Number(item.width) || null,
            height: Number(height) || Number(item.height) || null,
            depth
        });
    };

    append({
        filePath: item.filePath,
        url: item.url,
        mediaType: item.mediaType,
        width: item.width,
        height: item.height
    });

    if (item.kind === 'op' && ['image', 'video'].includes(item.nodeType)) {
        getGeneratorResultEntries(item).forEach(result => {
            const filePath = result.filePath || result.item?.filePath || '';
            const url = result.url || result.item?.url || '';
            append({
                filePath,
                url,
                mediaType: result.item?.mediaType || resolveGeneratorResultMediaType(result, filePath || url),
                width: result.item?.width,
                height: result.item?.height
            });
        });
    }
    return attachments;
}

function executableConnections(connections = []) {
    return (Array.isArray(connections) ? connections : []).filter(connection => connection?.kind !== 'history');
}

function resolveStaticText(nodeId, byId, incoming, resolving = new Set(), resolvedIds = new Set()) {
    const item = byId.get(nodeId);
    if (!item || item.kind !== 'op' || item.nodeType !== 'text' || resolving.has(nodeId)) return '';
    resolving.add(nodeId);
    resolvedIds.add(nodeId);
    const upstream = (incoming.get(nodeId) || [])
        .map(sourceId => resolveStaticText(sourceId, byId, incoming, resolving, resolvedIds))
        .filter(Boolean);
    resolving.delete(nodeId);
    const own = String(item.config?.text || '').trim();
    const separator = item.config?.separator === '' ? '\n' : String(item.config?.separator ?? '\n');
    return [...upstream, own].filter(Boolean).join(separator).trim();
}

export function collectUpstreamPromptContext({ targetNodeId, items, connections = [] } = {}) {
    const byId = items instanceof Map
        ? new Map([...items].map(([id, item]) => [id, dataForItem(item)]))
        : new Map((Array.isArray(items) ? items : []).map(item => {
            const data = dataForItem(item);
            return [data?.id, data];
        }).filter(([id, item]) => id && item));
    const target = byId.get(targetNodeId);
    if (!target) {
        return {
            prompt: '',
            upstreamPrompts: [],
            upstreamTextNodeIds: [],
            effectivePrompt: '',
            promptMergeMode: 'append'
        };
    }

    const incoming = new Map();
    executableConnections(connections).forEach(connection => {
        const fromId = connection?.from?.nodeId;
        const toId = connection?.to?.nodeId;
        if (!fromId || !toId) return;
        if (!incoming.has(toId)) incoming.set(toId, []);
        incoming.get(toId).push(fromId);
    });
    const upstreamTextNodeIds = new Set();
    const upstreamPrompts = (incoming.get(targetNodeId) || [])
        .filter(sourceId => byId.get(sourceId)?.nodeType === 'text')
        .map(sourceId => resolveStaticText(sourceId, byId, incoming, new Set(), upstreamTextNodeIds))
        .filter(Boolean);
    const prompt = String(target.config?.prompt || '').trim();
    const promptMergeMode = ['append', 'prepend', 'replace'].includes(target.config?.promptMergeMode)
        ? target.config.promptMergeMode
        : 'append';
    const mergedUpstream = upstreamPrompts.join('\n\n');
    let effectivePrompt = prompt;
    if (mergedUpstream) {
        if (!prompt || promptMergeMode === 'replace') effectivePrompt = mergedUpstream;
        else if (promptMergeMode === 'prepend') effectivePrompt = `${mergedUpstream}\n\n${prompt}`;
        else effectivePrompt = `${prompt}\n\n${mergedUpstream}`;
    }
    return {
        prompt,
        upstreamPrompts,
        upstreamTextNodeIds: [...upstreamTextNodeIds],
        effectivePrompt: effectivePrompt.trim(),
        promptMergeMode
    };
}

/**
 * Collect media reachable by walking backwards from a node. History edges are
 * included because they preserve the provenance chain of generated media.
 */
export function collectUpstreamMediaAttachments({
    targetNodeId,
    items,
    connections = [],
    transientSourceIds = []
} = {}) {
    const byId = items instanceof Map
        ? new Map([...items].map(([id, item]) => [id, dataForItem(item)]))
        : new Map((Array.isArray(items) ? items : []).map(item => {
            const data = dataForItem(item);
            return [data?.id, data];
        }).filter(([id, item]) => id && item));
    if (!targetNodeId || !byId.has(targetNodeId)) return [];

    const incoming = new Map();
    connections.forEach(connection => {
        const fromId = connection?.from?.nodeId;
        const toId = connection?.to?.nodeId;
        if (!fromId || !toId) return;
        if (!incoming.has(toId)) incoming.set(toId, []);
        incoming.get(toId).push(fromId);
    });

    const queue = [{ nodeId: targetNodeId, depth: 0 }];
    const visited = new Set([targetNodeId]);
    const seenAttachments = new Set();
    const attachments = [];
    while (queue.length > 0) {
        const current = queue.shift();
        const sourceIds = current.nodeId === targetNodeId
            ? [...transientSourceIds, ...(incoming.get(current.nodeId) || [])]
            : (incoming.get(current.nodeId) || []);
        for (const sourceId of sourceIds) {
            if (!byId.has(sourceId) || visited.has(sourceId)) continue;
            visited.add(sourceId);
            const depth = current.depth + 1;
            attachmentsForItem(byId.get(sourceId), depth).forEach(attachment => {
                const key = attachmentKey(attachment);
                if (!key || seenAttachments.has(key)) return;
                seenAttachments.add(key);
                attachments.push(attachment);
            });
            queue.push({ nodeId: sourceId, depth });
        }
    }
    return attachments;
}
