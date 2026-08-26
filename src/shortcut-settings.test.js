import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_SHORTCUTS,
    formatShortcut,
    matchesShortcut,
    normalizeShortcut,
    normalizeShortcutBindings,
    shortcutFromKeyboardEvent
} from './shortcut-settings.js';

test('normalizes shortcut aliases and modifier order', () => {
    assert.equal(normalizeShortcut('shift + ctrl + d'), 'Mod+Shift+D');
    assert.equal(normalizeShortcut('Command+Enter'), 'Mod+Enter');
    assert.equal(normalizeShortcut('ctrl+alt'), '');
});

test('fills missing or invalid bindings with defaults', () => {
    const bindings = normalizeShortcutBindings({ undo: 'Alt+U', run: 'Ctrl+Alt' });
    assert.equal(bindings.undo, 'Alt+U');
    assert.equal(bindings.run, DEFAULT_SHORTCUTS.run);
    assert.equal(bindings.fit, DEFAULT_SHORTCUTS.fit);
});

test('captures and matches exact keyboard modifiers', () => {
    const event = { key: 'd', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true };
    assert.equal(shortcutFromKeyboardEvent(event), 'Mod+Shift+D');
    assert.equal(matchesShortcut(event, 'Mod+Shift+D'), true);
    assert.equal(matchesShortcut(event, 'Mod+D'), false);
});

test('formats the platform command modifier for display', () => {
    assert.equal(formatShortcut('Mod+Enter', 'win32'), 'Ctrl+Enter');
    assert.equal(formatShortcut('Mod+Enter', 'darwin'), 'Command+Enter');
});
