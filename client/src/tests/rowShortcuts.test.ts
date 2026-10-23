import { describe, expect, it } from 'vitest';
import { EVERY_ROW_ACTIONS, ROW_ACTION_KEYS, rowActionButtonProps, rowActionForKey, withShortcutHint } from '../lib/rowShortcuts';

describe('rowShortcuts', () => {
    it('maps a letter to its row action only among the allowed ones, case-insensitively', () => {
        expect(rowActionForKey('c', EVERY_ROW_ACTIONS)).toBe('copyId');
        expect(rowActionForKey('E', EVERY_ROW_ACTIONS)).toBe('edit');
        // Done and Move to are Next Actions-only.
        expect(rowActionForKey('d', EVERY_ROW_ACTIONS)).toBeNull();
        expect(rowActionForKey('m', EVERY_ROW_ACTIONS)).toBeNull();
        expect(rowActionForKey('d', ['edit', 'done'])).toBe('done');
        expect(rowActionForKey('x', ['edit', 'done', 'copyId', 'moveTo'])).toBeNull();
    });

    it('every action has its own letter', () => {
        const letters = Object.values(ROW_ACTION_KEYS);
        expect(new Set(letters).size).toBe(letters.length);
    });

    it('a row button carries its action and announces its key; tooltips teach it', () => {
        expect(rowActionButtonProps('copyId')).toEqual({ 'data-row-action': 'copyId', 'aria-keyshortcuts': 'C' });
        expect(withShortcutHint('Copy item ID', 'c')).toBe('Copy item ID (c)');
    });
});
