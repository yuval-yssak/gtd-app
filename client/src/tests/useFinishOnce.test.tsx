// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFinishOnce } from '../hooks/useFinishOnce';

afterEach(cleanup);

describe('useFinishOnce', () => {
    it('does nothing until the work is done', () => {
        const onFinished = vi.fn();
        renderHook(() => useFinishOnce(false, onFinished));
        expect(onFinished).not.toHaveBeenCalled();
    });

    it('finishes once when the work completes', () => {
        const onFinished = vi.fn();
        const { rerender } = renderHook(({ isDone }) => useFinishOnce(isDone, onFinished), { initialProps: { isDone: false } });
        rerender({ isDone: true });
        expect(onFinished).toHaveBeenCalledOnce();
    });

    // A host re-rendering before its navigation commits hands over a fresh callback each time; the
    // finish (a toast + a navigation) must still happen exactly once.
    it('does not finish again when re-rendered with a new callback while still done', () => {
        const first = vi.fn();
        const second = vi.fn();
        const { rerender } = renderHook(({ onFinished }) => useFinishOnce(true, onFinished), { initialProps: { onFinished: first } });
        rerender({ onFinished: second });
        expect(first).toHaveBeenCalledOnce();
        expect(second).not.toHaveBeenCalled();
    });
});
