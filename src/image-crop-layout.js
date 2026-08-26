const DEFAULT_MIN_SIZE = 0.02;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
}

function stable(value) {
    return Math.round(value * 1e12) / 1e12;
}

export function normalizeCropRect(rect = {}, options = {}) {
    const minWidth = clamp(options.minWidth ?? DEFAULT_MIN_SIZE, 0, 1);
    const minHeight = clamp(options.minHeight ?? DEFAULT_MIN_SIZE, 0, 1);
    const width = clamp(rect.width ?? 1, minWidth, 1);
    const height = clamp(rect.height ?? 1, minHeight, 1);
    const x = clamp(rect.x, 0, 1 - width);
    const y = clamp(rect.y, 0, 1 - height);
    return { x: stable(x), y: stable(y), width: stable(width), height: stable(height) };
}

export function moveCropRect(rect, deltaX, deltaY) {
    const crop = normalizeCropRect(rect);
    return {
        ...crop,
        x: clamp(crop.x + (Number(deltaX) || 0), 0, 1 - crop.width),
        y: clamp(crop.y + (Number(deltaY) || 0), 0, 1 - crop.height)
    };
}

export function resizeCropRect(rect, handle, deltaX, deltaY, options = {}) {
    const minWidth = clamp(options.minWidth ?? DEFAULT_MIN_SIZE, 0, 1);
    const minHeight = clamp(options.minHeight ?? DEFAULT_MIN_SIZE, 0, 1);
    const crop = normalizeCropRect(rect, { minWidth, minHeight });
    let left = crop.x;
    let top = crop.y;
    let right = crop.x + crop.width;
    let bottom = crop.y + crop.height;
    const dx = Number(deltaX) || 0;
    const dy = Number(deltaY) || 0;

    if (String(handle).includes('w')) left = clamp(left + dx, 0, right - minWidth);
    if (String(handle).includes('e')) right = clamp(right + dx, left + minWidth, 1);
    if (String(handle).includes('n')) top = clamp(top + dy, 0, bottom - minHeight);
    if (String(handle).includes('s')) bottom = clamp(bottom + dy, top + minHeight, 1);

    return normalizeCropRect({
        x: left,
        y: top,
        width: right - left,
        height: bottom - top
    }, { minWidth, minHeight });
}

export function cropRectToPixels(rect, sourceWidth, sourceHeight) {
    const width = Math.max(1, Math.floor(Number(sourceWidth) || 0));
    const height = Math.max(1, Math.floor(Number(sourceHeight) || 0));
    const crop = normalizeCropRect(rect, {
        minWidth: 1 / width,
        minHeight: 1 / height
    });
    const left = clamp(Math.floor(crop.x * width), 0, width - 1);
    const top = clamp(Math.floor(crop.y * height), 0, height - 1);
    const right = clamp(Math.ceil((crop.x + crop.width) * width), left + 1, width);
    const bottom = clamp(Math.ceil((crop.y + crop.height) * height), top + 1, height);

    return {
        left,
        top,
        width: right - left,
        height: bottom - top
    };
}

export function getOrientedImageSize(width, height, orientation) {
    const sourceWidth = Math.max(1, Math.floor(Number(width) || 0));
    const sourceHeight = Math.max(1, Math.floor(Number(height) || 0));
    return [5, 6, 7, 8].includes(Number(orientation))
        ? { width: sourceHeight, height: sourceWidth }
        : { width: sourceWidth, height: sourceHeight };
}
