const THEME_STORAGE_KEY = 'flow-canvas-ui-theme-v1';
const ACCENT_STORAGE_KEY = 'flow-canvas-ui-accent-v1';
const THEMES = new Set(['dark', 'light']);
const DEFAULT_ACCENTS = {
    dark: '#777c85',
    light: '#6757e7'
};

export function normalizeAccent(value, fallback = DEFAULT_ACCENTS.light) {
    const normalized = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized.toLowerCase() : fallback;
}

export function readAccent(storage = globalThis.localStorage, fallback = DEFAULT_ACCENTS.light) {
    try {
        return normalizeAccent(storage?.getItem(ACCENT_STORAGE_KEY), fallback);
    } catch (_) {
        return fallback;
    }
}

function getAccentRgb(accent) {
    const value = normalizeAccent(accent).slice(1);
    return [0, 2, 4].map(index => Number.parseInt(value.slice(index, index + 2), 16));
}

function mixAccent(accent, target, amount) {
    const [r, g, b] = getAccentRgb(accent);
    const mixed = [r, g, b].map(channel => Math.round(channel + (target - channel) * amount));
    return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

function setAccentVariables(accent, root) {
    const normalized = normalizeAccent(accent);
    const [r, g, b] = getAccentRgb(normalized);
    root.style.setProperty('--accent', normalized);
    root.style.setProperty('--accent-hover', mixAccent(normalized, 0, 0.14));
    root.style.setProperty('--accent-strong', mixAccent(normalized, 0, 0.28));
    root.style.setProperty('--accent-border', mixAccent(normalized, 255, 0.52));
    root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
    root.style.setProperty('--hover-bg', `rgba(${r}, ${g}, ${b}, 0.07)`);
    root.style.setProperty('--scrollbar-thumb', `rgba(${r}, ${g}, ${b}, 0.28)`);
    root.style.setProperty('--scrollbar-thumb-hover', `rgba(${r}, ${g}, ${b}, 0.55)`);
    return normalized;
}

export function normalizeTheme(value) {
    return THEMES.has(value) ? value : 'dark';
}

export function readTheme(storage = globalThis.localStorage) {
    try {
        return normalizeTheme(storage?.getItem(THEME_STORAGE_KEY));
    } catch (_) {
        return 'dark';
    }
}

export function applyTheme(theme, root = document.documentElement) {
    const normalized = normalizeTheme(theme);
    root.dataset.theme = normalized;
    root.style.colorScheme = normalized;
    if (root?.dispatchEvent && typeof CustomEvent === 'function') {
        root.dispatchEvent(new CustomEvent('flow-canvas-theme-change', {
            detail: { theme: normalized }
        }));
    }
    return normalized;
}

export function getThemeColor(name, fallback) {
    if (typeof document === 'undefined') return fallback;
    const value = getComputedStyle(document.documentElement)
        .getPropertyValue(`--${name}`)
        .trim();
    return value || fallback;
}

export function initTheme({ root = document.documentElement, storage = globalThis.localStorage } = {}) {
    const initial = applyTheme(readTheme(storage), root);
    const accent = setAccentVariables(readAccent(storage, DEFAULT_ACCENTS[initial]), root);
    const select = document.getElementById('flowCanvasThemeSelect');
    if (select) {
        select.value = initial;
        select.addEventListener('change', () => {
            const next = applyTheme(select.value, root);
            try {
                storage?.setItem(THEME_STORAGE_KEY, next);
            } catch (_) {
                // Theme changes should still apply when storage is unavailable.
            }
            select.value = next;
        });
    }
    const colorPicker = document.getElementById('flowCanvasAccentColor');
    const colorValue = document.getElementById('flowCanvasAccentValue');
    const resetButton = document.getElementById('flowCanvasAccentResetBtn');
    if (!colorPicker) return initial;
    colorPicker.value = accent;
    if (colorValue) colorValue.textContent = accent.toUpperCase();
    const saveAccent = value => {
        const next = setAccentVariables(value, root);
        colorPicker.value = next;
        if (colorValue) colorValue.textContent = next.toUpperCase();
        try {
            storage?.setItem(ACCENT_STORAGE_KEY, next);
        } catch (_) {
            // Accent changes should still apply when storage is unavailable.
        }
        root.dispatchEvent(new CustomEvent('flow-canvas-theme-change', {
            detail: { theme: normalizeTheme(root.dataset.theme), accent: next }
        }));
    };
    colorPicker.addEventListener('input', () => saveAccent(colorPicker.value));
    resetButton?.addEventListener('click', () => saveAccent(DEFAULT_ACCENTS[normalizeTheme(root.dataset.theme)]));
    return initial;
}
