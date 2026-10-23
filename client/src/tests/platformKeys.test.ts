import { describe, expect, it } from 'vitest';
import { chordLabel, chordList } from '../lib/platformKeys';

describe('chordLabel', () => {
    it('spells a chord with Mac glyphs or with PC key names', () => {
        expect(chordLabel(['alt', 'shift', 'up'], true)).toBe('⌥⇧↑');
        expect(chordLabel(['alt', 'shift', 'up'], false)).toBe('Alt+Shift+↑');
        expect(chordLabel(['space'], true)).toBe('Space');
        expect(chordLabel(['enter'], false)).toBe('Enter');
    });

    it('names the Fn stand-ins for keys a Mac keyboard lacks', () => {
        expect(chordLabel(['home'], true)).toBe('Fn ←');
        expect(chordLabel(['pageDown'], true)).toBe('Fn ↓');
        expect(chordLabel(['home'], false)).toBe('Home');
        expect(chordLabel(['pageDown'], false)).toBe('PgDn');
        expect(chordLabel(['shift', 'f6'], true)).toBe('⇧Fn F6');
        expect(chordLabel(['shift', 'f6'], false)).toBe('Shift+F6');
        expect(chordLabel(['mod', 'enter'], true)).toBe('⌘↩');
        expect(chordLabel(['mod', 'enter'], false)).toBe('Ctrl+Enter');
    });

    it('lists alternative chords with a slash', () => {
        expect(chordList([['up'], ['down']], true)).toBe('↑ / ↓');
        expect(chordList([['alt', 'up']], false)).toBe('Alt+↑');
    });
});
