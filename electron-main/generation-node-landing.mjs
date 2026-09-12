import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { generationNodeSignature } from '../shared/generation-node-state.mjs';
import { convertGeneratorOutputConnections, getPorts, normalizeGeneratorInputPort } from '../src/graph-model.js';
import { appendGeneratorResult, resolveGeneratorResultMediaType } from '../src/generator-result-stack.js';
import { resolveGenerationDisplaySize } from '../src/image-node-settings.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const coordinate = value => Number.isFinite(Number(value)) ? Number(value) : 0;

function fail(code, message) {
    throw Object.assign(new Error(message), { code });
}

function validateTarget({ projectId, nodeId, expectedNode, operationId }) {
    if (![projectId, nodeId, operationId].every(value => typeof value === 'string' && value.trim())) {
        fail('INVALID_REQUEST', 'projectId, nodeId and operationId are required');
    }
    if (!object(expectedNode) || expectedNode.id !== nodeId) fail('INVALID_REQUEST', 'expectedNode must be the source node snapshot');
}

function requireUnchanged(source, expectedNode) {
    if (generationNodeSignature(source) !== generationNodeSignature(expectedNode)) {
        fail('SOURCE_CHANGED', 'Source node changed; downloaded files have been retained');
    }
}

function localFilePath(output) {
    if (!object(output) || output._batchResults !== undefined) {
        fail('INVALID_OUTPUT', 'Pass one downloaded generation result per operation');
    }
    let value = output._resultFilePath || output.image || output.video || output.file || output._resultItem?.filePath;
    if (typeof value !== 'string' || !value.trim()) fail('INVALID_OUTPUT', 'A local result filePath is required');
    if (/^local-res:\/\//i.test(value)) {
        try { value = decodeURIComponent(value.slice('local-res://'.length)); }
        catch { fail('INVALID_OUTPUT', 'Invalid local result filePath'); }
    }
    const drivePath = /^[a-z]:[\\/]/i.test(value);
    if (value.includes('\0') || /^[\\/]{2}/.test(value)
        || (!drivePath && /^[a-z][a-z\d+.-]*:/i.test(value))
        || !(drivePath ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value))) {
        fail('INVALID_OUTPUT', 'Generation results must use an absolute local filePath, not a remote URL');
    }
    return value;
}

function referenceNodes(project, source) {
    const accepted = source.nodeType === 'video' ? ['image', 'video', 'file'] : ['image'];
    return project.connections.filter(connection => connection.kind !== 'history'
        && connection.to.nodeId === source.id
        && normalizeGeneratorInputPort(source, connection.to.port) === 'source')
        .map(connection => {
            const node = project.items.find(item => item.id === connection.from.nodeId);
            const port = getPorts(node).outputs.find(entry => entry.name === connection.from.port);
            return accepted.includes(port?.dataType) ? node : null;
        }).filter(Boolean);
}

function generationRecord(project, source, output) {
    return {
        nodeType: source.nodeType,
        title: source.title || (source.nodeType === 'video' ? '\u89c6\u9891\u751f\u6210' : '\u56fe\u7247\u751f\u6210'),
        config: clone(source.config || {}),
        model: source.model || source.config?.model || '',
        references: referenceNodes(project, source).map(node => ({ itemId: node.id, filePath: node.filePath || '' })),
        generatedAt: Date.now(),
        ...(object(output._generation) ? clone(output._generation) : {})
    };
}

function convertImage(project, source, output, filePath) {
    const resultItem = object(output._resultItem) ? output._resultItem : {};
    const media = {
        ...clone(resultItem),
        id: source.id,
        kind: 'media',
        mediaType: resolveGeneratorResultMediaType(output, filePath),
        filePath,
        x: coordinate(source.x),
        y: coordinate(source.y),
        width: positive(source.width, positive(resultItem.width, 300)),
        height: positive(source.height, positive(resultItem.height, 300)),
        addedAt: Date.now(),
        generation: { ...generationRecord(project, source, output), replacedGenerator: true },
        runStatus: 'done',
        runError: ''
    };
    project.items[project.items.indexOf(source)] = media;
    project.connections = convertGeneratorOutputConnections(project.connections, source.id);
    return media.id;
}

function appendStack(project, source, output, filePath) {
    if (output._preserveGeneratorStack) source.preserveGeneratorStack = true;
    if (object(output._generation)) source.generation = clone(output._generation);
    else if (!source.generation) source.generation = generationRecord(project, source, output);
    const resultItem = object(output._resultItem) ? clone(output._resultItem) : null;
    const candidateIndex = output._candidateIndex ?? resultItem?.candidateIndex ?? null;
    const results = appendGeneratorResult(source, {
        filePath,
        url: output._resultUrl || '',
        item: candidateIndex == null ? resultItem : { ...(resultItem || {}), candidateIndex }
    });
    if (results.length === 1) {
        const width = Number(resultItem?.naturalWidth || resultItem?.pixelWidth || resultItem?.width);
        const height = Number(resultItem?.naturalHeight || resultItem?.pixelHeight || resultItem?.height);
        if (output._forceSquarePreview === true || (width > 0 && height > 0)) {
            // Same first-preview ratios and minimum edge as generator-placeholder-layout.
            const size = resolveGenerationDisplaySize({
                kind: source.nodeType,
                ratio: output._forceSquarePreview === true ? '1:1' : '',
                size: `${width}x${height}`,
                longEdge: source.nodeType === 'video' ? 320 : 264
            });
            source.width = Math.max(112, size.width);
            source.height = Math.max(112, size.height);
        }
    }
    source.runStatus = 'done';
    source.runError = '';
    return source.id;
}

function resultSlot(items, source, size) {
    const gap = 40;
    const x = Math.round(coordinate(source.x) + positive(source.width, 300) + gap);
    let y = Math.round(coordinate(source.y));
    // Test rectangles, including unfinished placeholders, rather than just origins.
    const column = items.filter(item => x < coordinate(item.x) + positive(item.width, 300) + gap
        && x + size.width + gap > coordinate(item.x))
        .sort((a, b) => coordinate(a.y) - coordinate(b.y));
    for (const item of column) {
        const top = coordinate(item.y);
        const bottom = top + positive(item.height, 156);
        if (y < bottom + gap && y + size.height + gap > top) y = Math.ceil(bottom + gap);
    }
    return { x, y };
}

function appendMedia(project, source, output, filePath) {
    const config = source.generation?.config || source.config || {};
    const size = resolveGenerationDisplaySize({
        kind: source.generation?.nodeType || source.nodeType,
        referenceSize: source,
        ratio: config.ratio,
        size: `${Number(config.width) || 1024}x${Number(config.height) || 1024}`,
        longEdge: 320
    });
    const resultItem = object(output._resultItem) ? output._resultItem : {};
    const requestedId = typeof resultItem.id === 'string' && resultItem.id ? resultItem.id : null;
    const id = requestedId && !project.items.some(item => item.id === requestedId) ? requestedId : `generation-${randomUUID()}`;
    project.items.push({
        ...clone(resultItem),
        id,
        kind: 'media',
        filePath,
        ...resultSlot(project.items, source, size),
        ...size,
        mediaType: resolveGeneratorResultMediaType(output, filePath),
        addedAt: Date.now(),
        fromNodeId: source.id,
        generation: clone(object(output._generation) ? output._generation : source.generation)
    });
    project.connections.push({
        id: `generation-link-${randomUUID()}`,
        kind: 'history',
        from: { nodeId: source.id, port: 'out' },
        to: { nodeId: id, port: 'source' }
    });
    return id;
}

/** Install after constructing the shared AgentBoardService; no network or file IO.
 * Call once per GraphRunner landed output with a stable, distinct operationId.
 * On success replace the runner's expected snapshot with the returned sourceNode.
 */
export function installGenerationNodeLanding(bridge, board) {
    bridge.landGenerationResult = async request => {
        const { projectId, nodeId, expectedNode, output, operationId } = clone(request) || {};
        validateTarget({ projectId, nodeId, expectedNode, operationId });
        const filePath = localFilePath(output);
        const key = createHash('sha256').update(JSON.stringify(['result', nodeId, operationId])).digest('hex');
        const result = await board.updateProject(projectId, project => {
            const source = project.items.find(item => item.id === nodeId);
            if (!source) fail('SOURCE_CHANGED', 'Source node was deleted; downloaded files have been retained');
            const records = Array.isArray(project.generationNodeLandings) ? project.generationNodeLandings : [];
            // A committed operation wins over its now-stale expected snapshot.
            const previous = records.find(record => record.key === key);
            if (previous) return { resultNodeId: previous.resultNodeId, duplicate: true };
            requireUnchanged(source, expectedNode);
            let resultNodeId;
            if (source.kind === 'op' && source.nodeType === 'image' && !output._preserveGeneratorStack) {
                resultNodeId = convertImage(project, source, output, filePath);
            } else if (source.kind === 'op' && ['image', 'video'].includes(source.nodeType)) {
                resultNodeId = appendStack(project, source, output, filePath);
            } else if (source.kind !== 'op' && source.generation?.nodeType === 'image') {
                resultNodeId = appendMedia(project, source, output, filePath);
            } else {
                fail('INVALID_SOURCE', 'Source must be an image/video generator or its converted image result');
            }
            // Keep only a digest and result ID, not outputs or snapshots. Do not evict
            // committed keys: an old retry must not append a second batch card.
            project.generationNodeLandings = [...records, { key, resultNodeId }];
            return { resultNodeId, duplicate: false };
        });
        return {
            projectId,
            nodeId,
            sourceNode: clone(result.items.find(item => item.id === nodeId)),
            ...result.value
        };
    };

    bridge.updateGenerationNodeStatus = async request => {
        const { projectId, nodeId, expectedNode, status, error, operationId } = clone(request) || {};
        validateTarget({ projectId, nodeId, expectedNode, operationId });
        if (!['idle', 'queued', 'running', 'done', 'error', 'canceled'].includes(status)) {
            fail('INVALID_REQUEST', 'Unknown generation node status');
        }
        const key = createHash('sha256').update(JSON.stringify(['status', nodeId, operationId])).digest('hex');
        const result = await board.updateProject(projectId, project => {
            const source = project.items.find(item => item.id === nodeId);
            if (!source) fail('SOURCE_CHANGED', 'Source node was deleted; no status was written');
            const keys = Array.isArray(project.generationNodeStatusKeys) ? project.generationNodeStatusKeys : [];
            if (keys.includes(key)) return { duplicate: true };
            requireUnchanged(source, expectedNode);
            if (status === 'queued' || (status === 'running' && !(Number(source.runStartedAt) > 0))) {
                source.runStartedAt = positive(expectedNode.runStartedAt, Date.now());
            }
            if (status === 'idle') delete source.runStartedAt;
            source.runStatus = status;
            source.runError = String(error?.message ?? error ?? '');
            project.generationNodeStatusKeys = [...keys, key];
            return { duplicate: false };
        });
        return { projectId, nodeId, sourceNode: clone(result.items.find(item => item.id === nodeId)), ...result.value };
    };
}
