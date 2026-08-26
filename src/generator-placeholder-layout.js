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
    const availableBelow = viewport.height - anchor.bottom - margin;
    const availableAbove = anchor.top - margin;
    const placeBelow = availableBelow >= popup.height || availableBelow >= availableAbove;
    const unclampedLeft = anchor.left + (anchor.width - popup.width) / 2;
    const maxLeft = Math.max(margin, viewport.width - popup.width - margin);
    const maxTop = Math.max(margin, viewport.height - popup.height - margin);
    const unclampedTop = placeBelow
        ? anchor.bottom + gap
        : anchor.top - popup.height - gap;

    return {
        left: Math.round(Math.min(maxLeft, Math.max(margin, unclampedLeft))),
        top: Math.round(Math.min(maxTop, Math.max(margin, unclampedTop))),
        placement: placeBelow ? 'below' : 'above'
    };
}
