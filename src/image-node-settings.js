export const IMAGE_RESOLUTION_TIERS = ['1K', '2K', '4K'];

export const IMAGE_ASPECT_RATIOS = [
    'adaptive',
    '1:1',
    '9:16',
    '16:9',
    '3:4',
    '4:3',
    '3:2',
    '2:3',
    '5:4',
    '4:5',
    '21:9'
];

const TIER_DIMENSIONS = {
    '1K': { square: 1024, long: 1536 },
    '2K': { square: 2048, long: 2048 },
    '4K': { square: 2880, long: 3840 }
};

function roundToStep(value, step = 16) {
    return Math.max(step, Math.round(Number(value) / step) * step);
}

function parseRatio(value) {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(value || ''));
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width > 0 && height > 0 ? width / height : null;
}

export function inferClosestAspectRatio(width, height, candidates = [], fallback = '') {
    const targetRatio = (Number(width) || 0) / (Number(height) || 0);
    const supported = (Array.isArray(candidates) ? candidates : [])
        .map(value => ({ value: String(value), ratio: parseRatio(value) }))
        .filter(candidate => Number.isFinite(candidate.ratio) && candidate.ratio > 0);
    if (!Number.isFinite(targetRatio) || targetRatio <= 0 || !supported.length) {
        return supported.some(candidate => candidate.value === fallback)
            ? fallback
            : (supported[0]?.value || fallback);
    }
    return supported.reduce((best, candidate) => {
        const distance = Math.abs(Math.log(candidate.ratio / targetRatio));
        return !best || distance < best.distance ? { ...candidate, distance } : best;
    }, null)?.value || fallback;
}

export function inferImageResolutionTier(width, height) {
    const longest = Math.max(Number(width) || 0, Number(height) || 0);
    if (longest >= 3200) return '4K';
    if (longest >= 1800) return '2K';
    return '1K';
}

export function inferImageAspectRatio(width, height) {
    const ratio = (Number(width) || 0) / (Number(height) || 0);
    if (!Number.isFinite(ratio) || ratio <= 0) return 'adaptive';
    const candidates = IMAGE_ASPECT_RATIOS
        .filter(value => value !== 'adaptive')
        .map(value => ({ value, ratio: parseRatio(value) }));
    const nearest = candidates.reduce((best, candidate) => {
        const distance = Math.abs(candidate.ratio - ratio);
        return !best || distance < best.distance ? { ...candidate, distance } : best;
    }, null);
    return nearest && nearest.distance <= 0.035 ? nearest.value : 'adaptive';
}

export function resolveImageDimensions(tier, ratio, fallback = {}) {
    const normalizedTier = IMAGE_RESOLUTION_TIERS.includes(tier) ? tier : '1K';
    const dimensions = TIER_DIMENSIONS[normalizedTier];
    let numericRatio = parseRatio(ratio);
    if (!numericRatio && ratio === 'adaptive') {
        const fallbackRatio = (Number(fallback.width) || 0) / (Number(fallback.height) || 0);
        numericRatio = Number.isFinite(fallbackRatio) && fallbackRatio > 0 ? fallbackRatio : 1;
    }
    if (!numericRatio) numericRatio = 1;

    if (Math.abs(numericRatio - 1) < 0.01) {
        return { width: dimensions.square, height: dimensions.square };
    }
    if (numericRatio > 1) {
        return {
            width: dimensions.long,
            height: roundToStep(dimensions.long / numericRatio)
        };
    }
    return {
        width: roundToStep(dimensions.long * numericRatio),
        height: dimensions.long
    };
}

export function resolveGenerationDisplaySize({
    kind = 'image',
    referenceSize = null,
    ratio = '',
    size = '',
    longEdge = 320
} = {}) {
    const referenceWidth = Number(referenceSize?.width) || 0;
    const referenceHeight = Number(referenceSize?.height) || 0;
    if (referenceWidth > 0 && referenceHeight > 0) {
        return { width: referenceWidth, height: referenceHeight };
    }

    const sizeMatch = String(size || '').match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)$/i);
    const numericRatio = parseRatio(ratio)
        || (sizeMatch ? Number(sizeMatch[1]) / Number(sizeMatch[2]) : null)
        || (kind === 'image' ? 1 : 16 / 9);
    const edge = Math.max(48, Number(longEdge) || 320);
    return numericRatio >= 1
        ? { width: Math.round(edge), height: Math.round(edge / numericRatio) }
        : { width: Math.round(edge * numericRatio), height: Math.round(edge) };
}
