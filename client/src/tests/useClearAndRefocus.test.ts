import { describe, expect, it, vi } from 'vitest';
import { clearFieldAndRefocus } from '../components/pickers/useClearAndRefocus';

// The hook itself only wires a ref to this pure function, so the decision is tested here without a
// React render (vitest runs in node, no DOM).

function clearWith(detail: number) {
    const onChange = vi.fn();
    const focus = vi.fn();
    clearFieldAndRefocus(onChange, { focus }, { detail });
    return { onChange, focus };
}

describe('clearFieldAndRefocus', () => {
    it('empties the field and refocuses the input when Clear is activated from the keyboard', () => {
        // Enter/Space synthesise a click with detail 0 — the only case where focus needs rescuing,
        // because the Clear button is about to unmount from under the keyboard user.
        const { onChange, focus } = clearWith(0);
        expect(onChange).toHaveBeenCalledWith('');
        expect(focus).toHaveBeenCalledTimes(1);
    });

    it('empties the field but leaves focus alone on a pointer click', () => {
        // On iOS, focusing a native date/time input inside a tap opens its picker — which can write
        // a date straight back into the field that was just cleared.
        const { onChange, focus } = clearWith(1);
        expect(onChange).toHaveBeenCalledWith('');
        expect(focus).not.toHaveBeenCalled();
    });

    it('tolerates an unmounted input on keyboard clear', () => {
        const onChange = vi.fn();
        expect(() => clearFieldAndRefocus(onChange, null, { detail: 0 })).not.toThrow();
        expect(onChange).toHaveBeenCalledWith('');
    });
});
