const WHEEL_LINE_HEIGHT = 16;
const MAX_WHEEL_DELTA_PER_EVENT = 240;
const WHEEL_ZOOM_SENSITIVITY = 0.001;
const MAX_ZOOM_FACTOR_PER_FRAME = 1.2;
export const MIN_VIEWPORT_SCALE = 0.1;
export const MAX_VIEWPORT_SCALE = 32;
export const ZOOM_SLIDER_STEPS = 1000;
export const TEXT_CONTENT_MIN_SCALE = 0.6;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export function isCanvasTextContentVisible(scale, minScale = TEXT_CONTENT_MIN_SCALE) {
    return (Number(scale) || 0) >= minScale;
}

export function normalizeWheelDelta(event, viewportHeight = 800) {
    const deltaX = Number(event?.deltaX) || 0;
    let deltaY = Number(event?.deltaY) || 0;
    if (Math.abs(deltaY) < 0.01 || Math.abs(deltaY) < Math.abs(deltaX)) return 0;

    if (event?.deltaMode === 1) deltaY *= WHEEL_LINE_HEIGHT;
    if (event?.deltaMode === 2) deltaY *= Math.max(1, Number(viewportHeight) || 800);
    return clamp(deltaY, -MAX_WHEEL_DELTA_PER_EVENT, MAX_WHEEL_DELTA_PER_EVENT);
}

export function wheelZoomFactor(delta) {
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.01) return 1;
    return clamp(
        Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY),
        1 / MAX_ZOOM_FACTOR_PER_FRAME,
        MAX_ZOOM_FACTOR_PER_FRAME
    );
}

export function scaleToSliderValue(
    scale,
    minScale = MIN_VIEWPORT_SCALE,
    maxScale = MAX_VIEWPORT_SCALE,
    steps = ZOOM_SLIDER_STEPS
) {
    const boundedScale = clamp(Number(scale) || 1, minScale, maxScale);
    const normalized = Math.log(boundedScale / minScale) / Math.log(maxScale / minScale);
    return Math.round(clamp(normalized, 0, 1) * steps);
}

export function sliderValueToScale(
    value,
    minScale = MIN_VIEWPORT_SCALE,
    maxScale = MAX_VIEWPORT_SCALE,
    steps = ZOOM_SLIDER_STEPS
) {
    const normalized = clamp((Number(value) || 0) / steps, 0, 1);
    return minScale * Math.pow(maxScale / minScale, normalized);
}

export function zoomViewportAtPoint(
    viewport,
    pointer,
    factor,
    minScale = MIN_VIEWPORT_SCALE,
    maxScale = MAX_VIEWPORT_SCALE
) {
    const oldScale = clamp(Number(viewport?.scale) || 1, minScale, maxScale);
    const nextScale = clamp(oldScale * (Number(factor) || 1), minScale, maxScale);
    const pointerX = Number(pointer?.x) || 0;
    const pointerY = Number(pointer?.y) || 0;
    const worldX = (pointerX - (Number(viewport?.x) || 0)) / oldScale;
    const worldY = (pointerY - (Number(viewport?.y) || 0)) / oldScale;

    return {
        scale: nextScale,
        x: pointerX - worldX * nextScale,
        y: pointerY - worldY * nextScale
    };
}
