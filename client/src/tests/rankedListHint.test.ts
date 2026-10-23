import { describe, expect, it } from 'vitest';
import { reorderHintText } from '../components/rankedList/rankedListHint';

describe('reorderHintText', () => {
    it('spells the chords for the platform and names every key the list answers to', () => {
        const mac = reorderHintText(true, ['edit', 'done', 'copyId', 'moveTo'], 'day');
        expect(mac).toContain('⇧↑ or ⇧↓ to jump');
        expect(mac).toContain('⌥⇧↑ or ⌥⇧↓ moves it to the top or bottom of its day');
        const pc = reorderHintText(false, ['edit', 'done', 'copyId', 'moveTo'], 'day');
        expect(pc).toContain('Alt+Shift+↑ or Alt+Shift+↓');
        for (const key of ['Arrow Right', 'Home and End', 'E edits', 'D marks it done', 'C copies', 'M opens', 'Space to pick', 'Escape to cancel']) {
            expect(pc).toContain(key);
        }
    });

    it('names only the letters this list has, and its own section noun', () => {
        const inbox = reorderHintText(false, ['edit', 'copyId', 'moveTo'], 'list');
        expect(inbox).not.toContain('marks it done');
        expect(inbox).toContain('top or bottom of its list.');
    });
});
