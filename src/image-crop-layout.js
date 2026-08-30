const DEFAULT_MIN_SIZE = 0.02;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
}

function stable(value) {
    return Math.round(value * 1e12) / 1e12;
}

export function parseCropAspectRatio(value) {
    const source = String(value ?? '').trim().replace(/\s+/g, '');
    if (!source) return null;
    const pair = source.match(/^(\d+(?:\.\d+)?)(?::|\/|x|×)(\d+(?:\.\d+)?)$/i);
    if (pair) {
        const width = Number(pair[1]);
        const height = Number(pair[2]);
        return width > 0 && height > 0 ? stable(width / height) : null;
    }
    const numeric = Number(source);
    return Number.isFinite(numeric) && numeric > 0 ? stable(numeric) : null;
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

function normalizedAspectRatio(aspectRatio, sourceAspect) {
    const target = Number(aspectRatio);
    const source = Number(sourceAspect);
    if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(source) || source <= 0) return null;
    return target / source;
}

export function fitCropRectToAspect(rect, aspectRatio, sourceAspect = 1) {
    const crop = normalizeCropRect(rect);
    const ratio = normalizedAspectRatio(aspectRatio, sourceAspect);
    if (!ratio) return crop;

    let width = crop.width;
    let height = width / ratio;
    if (height > crop.height) {
        height = crop.height;
        width = height * ratio;
    }
    const centerX = crop.x + crop.width / 2;
    const centerY = crop.y + crop.height / 2;
    return normalizeCropRect({
        x: clamp(centerX - width / 2, 0, 1 - width),
        y: clamp(centerY - height / 2, 0, 1 - height),
        width,
        height
    });
}

function lockedResizeCropRect(crop, handle, deltaX, deltaY, ratio, minWidth, minHeight) {
    const direction = String(handle || '').toLowerCase();
    const movesWest = direction.includes('w');
    const movesEast = direction.includes('e');
    const movesNorth = direction.includes('n');
    const movesSouth = direction.includes('s');
    const left = crop.x;
    const top = crop.y;
    const right = crop.x + crop.width;
    const bottom = crop.y + crop.height;
    const dx = Number(deltaX) || 0;
    const dy = Number(deltaY) || 0;

    if ((movesWest || movesEast) && (movesNorth || movesSouth)) {
        const anchorX = movesWest ? right : left;
        const anchorY = movesNorth ? bottom : top;
        const xDirection = movesWest ? -1 : 1;
        const yDirection = movesNorth ? -1 : 1;
        const movingX = (movesWest ? left : right) + dx;
        const movingY = (movesNorth ? top : bottom) + dy;
        const widthFromX = Math.max(0, (movingX - anchorX) * xDirection);
        const heightFromY = Math.max(0, (movingY - anchorY) * yDirection);
        const widthFromY = heightFromY * ratio;
        const xChange = Math.abs(widthFromX - crop.width) / Math.max(crop.width, 1e-9);
        const yChange = Math.abs(widthFromY - crop.width) / Math.max(crop.width, 1e-9);
        const desiredWidth = xChange >= yChange ? widthFromX : widthFromY;
        const horizontalLimit = xDirection > 0 ? 1 - anchorX : anchorX;
        const verticalLimit = yDirection > 0 ? 1 - anchorY : anchorY;
        const maxWidth = Math.max(0, Math.min(horizontalLimit, verticalLimit * ratio));
        const lockedMinWidth = Math.min(maxWidth, Math.max(minWidth, minHeight * ratio));
        const width = clamp(desiredWidth, lockedMinWidth, maxWidth);
        const height = width / ratio;
        return normalizeCropRect({
            x: xDirection > 0 ? anchorX : anchorX - width,
            y: yDirection > 0 ? anchorY : anchorY - height,
            width,
            height
        }, { minWidth: Math.min(minWidth, width), minHeight: Math.min(minHeight, height) });
    }

    if (movesWest || movesEast) {
        const anchorX = movesWest ? right : left;
        const xDirection = movesWest ? -1 : 1;
        const movingX = (movesWest ? left : right) + dx;
        const desiredWidth = Math.max(0, (movingX - anchorX) * xDirection);
        const centerY = top + crop.height / 2;
        const horizontalLimit = xDirection > 0 ? 1 - anchorX : anchorX;
        const verticalLimit = 2 * Math.min(centerY, 1 - centerY) * ratio;
        const maxWidth = Math.max(0, Math.min(horizontalLimit, verticalLimit));
        const lockedMinWidth = Math.min(maxWidth, Math.max(minWidth, minHeight * ratio));
        const width = clamp(desiredWidth, lockedMinWidth, maxWidth);
        const height = width / ratio;
        return normalizeCropRect({
            x: xDirection > 0 ? anchorX : anchorX - width,
            y: centerY - height / 2,
            width,
            height
        }, { minWidth: Math.min(minWidth, width), minHeight: Math.min(minHeight, height) });
    }

    if (movesNorth || movesSouth) {
        const anchorY = movesNorth ? bottom : top;
        const yDirection = movesNorth ? -1 : 1;
        const movingY = (movesNorth ? top : bottom) + dy;
        const desiredHeight = Math.max(0, (movingY - anchorY) * yDirection);
        const centerX = left + crop.width / 2;
        const verticalLimit = yDirection > 0 ? 1 - anchorY : anchorY;
        const horizontalLimit = 2 * Math.min(centerX, 1 - centerX) / ratio;
        const maxHeight = Math.max(0, Math.min(verticalLimit, horizontalLimit));
        const lockedMinHeight = Math.min(maxHeight, Math.max(minHeight, minWidth / ratio));
        const height = clamp(desiredHeight, lockedMinHeight, maxHeight);
        const width = height * ratio;
        return normalizeCropRect({
            x: centerX - width / 2,
            y: yDirection > 0 ? anchorY : anchorY - height,
            width,
            height
        }, { minWidth: Math.min(minWidth, width), minHeight: Math.min(minHeight, height) });
    }

    return crop;
}

export function resizeCropRect(rect, handle, deltaX, deltaY, options = {}) {
    const minWidth = clamp(options.minWidth ?? DEFAULT_MIN_SIZE, 0, 1);
    const minHeight = clamp(options.minHeight ?? DEFAULT_MIN_SIZE, 0, 1);
    const crop = normalizeCropRect(rect, { minWidth, minHeight });
    const ratio = normalizedAspectRatio(options.aspectRatio, options.sourceAspect);
    if (ratio) {
        return lockedResizeCropRect(crop, handle, deltaX, deltaY, ratio, minWidth, minHeight);
    }
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
