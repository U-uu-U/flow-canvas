export const UI_SCALE_LIMIT_KEY = 'flow-canvas-ui-scale-limit-v1';
export const UI_SCALE_LIMIT_CHANGED = 'flow-canvas-ui-scale-limit-change';
export const DEFAULT_UI_SCALE_LIMIT = 2;
export const MIN_UI_SCALE_LIMIT = 1;
export const MAX_UI_SCALE_LIMIT = 6;

export function normalizeUiScaleLimit(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return DEFAULT_UI_SCALE_LIMIT;
    return Math.round(Math.max(MIN_UI_SCALE_LIMIT, Math.min(MAX_UI_SCALE_LIMIT, number)) * 10) / 10;
}

export function readUiScaleLimit(storage = globalThis.localStorage) {
    try {
        return normalizeUiScaleLimit(storage?.getItem(UI_SCALE_LIMIT_KEY));
    } catch (_) {
        return DEFAULT_UI_SCALE_LIMIT;
    }
}

export function getUiCompensationScale(stageScale, limit = DEFAULT_UI_SCALE_LIMIT) {
    const zoom = Math.max(0.01, Number(stageScale) || 1);
    return Math.min(1 / zoom, normalizeUiScaleLimit(limit));
}

export function getUiScreenScale(stageScale, limit = DEFAULT_UI_SCALE_LIMIT) {
    const zoom = Math.max(0.01, Number(stageScale) || 1);
    return Math.min(1, zoom * getUiCompensationScale(zoom, limit));
}

export function initCanvasUiScaleSettings() {
    const slider = document.getElementById('canvasUiScaleLimit');
    const output = document.getElementById('canvasUiScaleLimitValue');
    const reset = document.getElementById('canvasUiScaleLimitReset');
    if (!slider) return;
    slider.min = String(MIN_UI_SCALE_LIMIT);
    slider.max = String(MAX_UI_SCALE_LIMIT);
    slider.step = '0.1';
    const apply = (value, persist = false) => {
        const limit = normalizeUiScaleLimit(value);
        slider.value = String(limit);
        const label = `${limit.toFixed(1)} \u500d`;
        if (output) output.value = label;
        slider.setAttribute('aria-valuetext', label);
        slider.style.setProperty('--range-progress', `${(limit - MIN_UI_SCALE_LIMIT) / (MAX_UI_SCALE_LIMIT - MIN_UI_SCALE_LIMIT) * 100}%`);
        if (persist) {
            try {
                localStorage.setItem(UI_SCALE_LIMIT_KEY, String(limit));
            } catch (_) { /* Settings remain usable without local storage. */ }
        }
        document.documentElement.dispatchEvent(new CustomEvent(UI_SCALE_LIMIT_CHANGED, { detail: { limit } }));
    };
    const onInput = () => apply(slider.value, true);
    const onReset = () => apply(DEFAULT_UI_SCALE_LIMIT, true);
    const onStorage = event => {
        if (event.key === UI_SCALE_LIMIT_KEY || event.key === null) apply(event.newValue);
    };
    apply(readUiScaleLimit());
    slider.addEventListener('input', onInput);
    reset?.addEventListener('click', onReset);
    window.addEventListener('storage', onStorage);
    if (import.meta.hot) import.meta.hot.dispose(() => {
        slider.removeEventListener('input', onInput);
        reset?.removeEventListener('click', onReset);
        window.removeEventListener('storage', onStorage);
    });
}
