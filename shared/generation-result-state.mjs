import { appendGeneratorResult } from '../src/generator-result-stack.js';
import { resolveGenerationDisplaySize } from '../src/image-node-settings.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** Mutate only generator result state; callers own routing, validation and persistence.
 * Returns the source, or null without changes when there is no stackable result.
 * generation supplies fallback provenance; now supplies a missing generatedAt.
 * Batch landings stay running unless the caller explicitly sets completed: true.
 */
export function applyGeneratorStackResult(source, output, { generation, now = Date.now(), completed = false } = {}) {
    if (source?.kind !== 'op' || !['image', 'video'].includes(source.nodeType)) return null;
    const resultItem = object(output?._resultItem) ? structuredClone(output._resultItem) : null;
    const filePath = output?._resultFilePath || resultItem?.filePath || '';
    const url = output?._resultUrl || resultItem?.url || '';
    if (!filePath && !url) return null;

    if (output?._preserveGeneratorStack) source.preserveGeneratorStack = true;
    const record = object(output?._generation) ? output._generation : generation;
    if (object(record)) {
        source.generation = structuredClone(record);
        source.generation.generatedAt ??= now;
    }
    const candidateIndex = output?._candidateIndex ?? resultItem?.candidateIndex ?? null;
    const results = appendGeneratorResult(source, {
        filePath,
        url,
        item: candidateIndex == null ? resultItem : { ...(resultItem || {}), candidateIndex }
    });
    if (results.length === 1) {
        const width = Number(resultItem?.naturalWidth || resultItem?.pixelWidth || resultItem?.width);
        const height = Number(resultItem?.naturalHeight || resultItem?.pixelHeight || resultItem?.height);
        const square = output?._forceSquarePreview === true;
        if (square || (width > 0 && height > 0)) {
            const kind = square ? 'image' : source.nodeType;
            const size = resolveGenerationDisplaySize({
                kind, ratio: square ? '1:1' : '', size: `${width}x${height}`,
                longEdge: kind === 'video' ? 320 : 264
            });
            source.width = Math.max(112, size.width);
            source.height = Math.max(112, size.height);
        }
    }
    if (completed === true) {
        source.runStatus = 'done';
        source.runError = '';
    }
    return source;
}
