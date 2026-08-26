export const SHORTCUT_STORAGE_KEY = 'flow-canvas-shortcuts-v1';
export const SHORTCUTS_CHANGED_EVENT = 'flow-canvas-shortcuts-updated';

export const SHORTCUT_DEFINITIONS = Object.freeze([
    { action: 'undo', label: '撤销', description: '撤销上一次画布操作', defaultBinding: 'Mod+Z' },
    { action: 'redo', label: '重做', description: '恢复刚撤销的画布操作', defaultBinding: 'Mod+Y' },
    { action: 'duplicate', label: '复制所选', description: '复制当前选中的节点或素材', defaultBinding: 'Mod+D' },
    { action: 'run', label: '运行节点', description: '运行当前选中的生成节点', defaultBinding: 'Mod+Enter' },
    { action: 'delete', label: '删除所选', description: '从画布移除当前所选内容', defaultBinding: 'Delete' },
    { action: 'fit', label: '适配视口', description: '让全部画布内容回到可视范围', defaultBinding: 'F' }
]);

export const DEFAULT_SHORTCUTS = Object.freeze(Object.fromEntries(
    SHORTCUT_DEFINITIONS.map(definition => [definition.action, definition.defaultBinding])
));

const KEY_ALIASES = Object.freeze({
    ' ': 'Space',
    spacebar: 'Space',
    esc: 'Escape',
    del: 'Delete',
    return: 'Enter',
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
    '+': 'Plus',
    '-': 'Minus'
});

const MODIFIER_KEYS = new Set(['control', 'ctrl', 'meta', 'command', 'cmd', 'alt', 'option', 'shift', 'mod']);

function normalizeKey(value) {
    const source = String(value || '');
    if (source === ' ') return 'Space';
    const raw = source.trim();
    if (!raw) return '';
    const lower = raw.toLowerCase();
    if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
    if (lower === 'plus') return 'Plus';
    if (lower === 'minus') return 'Minus';
    if (raw.length === 1) return raw.toUpperCase();
    if (/^f\d{1,2}$/i.test(raw)) return raw.toUpperCase();
    return raw[0].toUpperCase() + raw.slice(1);
}

export function normalizeShortcut(value) {
    const tokens = String(value || '')
        .split('+')
        .map(token => token.trim())
        .filter(Boolean);
    if (tokens.length === 0) return '';

    const modifiers = new Set();
    let key = '';
    for (const token of tokens) {
        const lower = token.toLowerCase();
        if (['mod', 'control', 'ctrl', 'meta', 'command', 'cmd'].includes(lower)) {
            modifiers.add('Mod');
        } else if (['alt', 'option'].includes(lower)) {
            modifiers.add('Alt');
        } else if (lower === 'shift') {
            modifiers.add('Shift');
        } else {
            if (key) return '';
            key = normalizeKey(token);
        }
    }
    if (!key || MODIFIER_KEYS.has(key.toLowerCase())) return '';
    return ['Mod', 'Alt', 'Shift']
        .filter(modifier => modifiers.has(modifier))
        .concat(key)
        .join('+');
}

export function normalizeShortcutBindings(value = {}) {
    return Object.fromEntries(SHORTCUT_DEFINITIONS.map(definition => {
        const normalized = normalizeShortcut(value?.[definition.action]);
        return [definition.action, normalized || definition.defaultBinding];
    }));
}

export function shortcutFromKeyboardEvent(event) {
    const key = normalizeKey(event?.key);
    if (!key || MODIFIER_KEYS.has(String(event?.key || '').toLowerCase())) return '';
    return [
        event.ctrlKey || event.metaKey ? 'Mod' : '',
        event.altKey ? 'Alt' : '',
        event.shiftKey ? 'Shift' : '',
        key
    ].filter(Boolean).join('+');
}

export function matchesShortcut(event, value) {
    const normalized = normalizeShortcut(value);
    if (!normalized) return false;
    const tokens = normalized.split('+');
    const key = tokens.at(-1);
    const expectsMod = tokens.includes('Mod');
    const hasMod = Boolean(event?.ctrlKey || event?.metaKey);
    if (expectsMod !== hasMod) return false;
    if (tokens.includes('Alt') !== Boolean(event?.altKey)) return false;
    if (tokens.includes('Shift') !== Boolean(event?.shiftKey)) return false;
    return normalizeKey(event?.key) === key;
}

export function formatShortcut(value, platform = '') {
    const normalized = normalizeShortcut(value);
    if (!normalized) return '';
    const commandLabel = String(platform).toLowerCase() === 'darwin' ? 'Command' : 'Ctrl';
    return normalized
        .replace(/^Mod(?=\+|$)/, commandLabel)
        .replace(/\bPlus\b/g, '+')
        .replace(/\bMinus\b/g, '-');
}

export function loadShortcutBindings(storage = globalThis.localStorage) {
    try {
        return normalizeShortcutBindings(JSON.parse(storage?.getItem(SHORTCUT_STORAGE_KEY) || '{}'));
    } catch (_) {
        return { ...DEFAULT_SHORTCUTS };
    }
}

export function saveShortcutBindings(bindings, storage = globalThis.localStorage) {
    const normalized = normalizeShortcutBindings(bindings);
    storage?.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
}
