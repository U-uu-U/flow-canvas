const DEFAULT_LONG_EDGE = {
    image: 264,
    video: 320
};

export function parseAspectRatio(value) {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(value || '').trim());
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width > 0 && height > 0 ? width / height : null;
}

export function getGeneratorPlaceholderSize(nodeType, config = {}, reference = null) {
    const kind = nodeType === 'video' ? 'video' : 'image';
    const referenceRatio = (Number(reference?.width) || 0) / (Number(reference?.height) || 0);
    const configuredRatio = parseAspectRatio(config.ratio);
    const fallbackRatio = (Number(config.width) || 0) / (Number(config.height) || 0);
    const ratio = configuredRatio
        || (Number.isFinite(referenceRatio) && referenceRatio > 0 ? referenceRatio : null)
        || (Number.isFinite(fallbackRatio) && fallbackRatio > 0 ? fallbackRatio : null)
        || (kind === 'video' ? 16 / 9 : 1);
    const longEdge = DEFAULT_LONG_EDGE[kind];

    if (ratio >= 1) {
        return {
            width: longEdge,
            height: Math.max(112, Math.round(longEdge / ratio))
        };
    }
    return {
        width: Math.max(112, Math.round(longEdge * ratio)),
        height: longEdge
    };
}

export function getGeneratorComposerPosition(anchor, popup, viewport, options = {}) {
    const gap = Math.max(0, Number(options.gap) || 14);
    const margin = Math.max(0, Number(options.margin) || 12);
    const bounds = options.bounds || {};
    const boundsLeft = Number.isFinite(Number(bounds.left)) ? Number(bounds.left) : 0;
    const boundsTop = Number.isFinite(Number(bounds.top)) ? Number(bounds.top) : 0;
    const boundsRight = Number.isFinite(Number(bounds.right)) ? Number(bounds.right) : viewport.width;
    const boundsBottom = Number.isFinite(Number(bounds.bottom)) ? Number(bounds.bottom) : viewport.height;
    const availableBelow = boundsBottom - anchor.bottom - margin;
    const availableAbove = anchor.top - boundsTop - margin;
    const placeBelow = availableBelow >= popup.height || availableBelow >= availableAbove;
    const unclampedLeft = anchor.left + (anchor.width - popup.width) / 2;
    const minLeft = boundsLeft + margin;
    const minTop = boundsTop + margin;
    const maxLeft = Math.max(minLeft, boundsRight - popup.width - margin);
    const maxTop = Math.max(minTop, boundsBottom - popup.height - margin);
    const unclampedTop = placeBelow
        ? anchor.bottom + gap
        : anchor.top - popup.height - gap;

    return {
        left: Math.round(Math.min(maxLeft, Math.max(minLeft, unclampedLeft))),
        top: Math.round(Math.min(maxTop, Math.max(minTop, unclampedTop))),
        placement: placeBelow ? 'below' : 'above'
    };
}

export function getGeneratorSplitPositions(source = {}, count = 4, options = {}) {
    const width = Math.max(1, Number(source.width) || DEFAULT_LONG_EDGE.image);
    const height = Math.max(1, Number(source.height) || DEFAULT_LONG_EDGE.image);
    const x = Number(source.x) || 0;
    const y = Number(source.y) || 0;
    const columns = Math.max(1, Math.min(Math.trunc(Number(options.columns) || 2), count));
    const gap = Math.max(0, Number(options.gap) || 24);
    const offsetX = Math.max(0, Number(options.offsetX) || 72);
    const rows = Math.ceil(Math.max(0, count) / columns);
    const gridHeight = rows > 0 ? rows * height + (rows - 1) * gap : 0;
    const baseX = x + width + offsetX;
    const baseY = y + (height - gridHeight) / 2;

    return Array.from({ length: Math.max(0, count) }, (_, index) => ({
        x: Math.round(baseX + (index % columns) * (width + gap)),
        y: Math.round(baseY + Math.floor(index / columns) * (height + gap)),
        width,
        height
    }));
}
