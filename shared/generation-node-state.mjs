import { getGeneratorResultEntries } from '../src/generator-result-stack.js';

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort()
            .filter(key => value[key] !== undefined)
            .map(key => [key, canonical(value[key])]));
    }
    return value;
}

function resultItemState(item) {
    if (!item || typeof item !== 'object') return null;
    const { x, y, width, height, runStatus, runError, runStartedAt, ...state } = item;
    return state;
}

/** Stable semantic snapshot for both GraphRunner and the main-process writer.
 * Canvas geometry, UI bookkeeping and execution status are deliberately excluded.
 * Config dimensions remain significant; legacy and normalized stacks are equivalent.
 */
export function generationNodeSignature(node) {
    if (!node || typeof node !== 'object') return 'null';
    return JSON.stringify(canonical({
        id: node.id,
        kind: node.kind || 'media',
        nodeType: node.nodeType || '',
        config: node.config || {},
        model: node.model || '',
        filePath: node.filePath || '',
        url: node.url || '',
        mediaType: node.mediaType || '',
        generation: node.generation || null,
        preserveGeneratorStack: node.preserveGeneratorStack === true,
        resultEntries: getGeneratorResultEntries(node).map(entry => ({
            filePath: entry.filePath,
            url: entry.url,
            item: resultItemState(entry.item)
        }))
    }));
}
