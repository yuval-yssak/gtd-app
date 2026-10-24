// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GHOST_ROW_ATTR, ListRowShell } from '../components/ListRowShell';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

function collapseWrapperOf(text: string) {
    const wrapper = screen.getByText(text).closest('[data-list-item-id]')?.parentElement;
    if (!wrapper) throw new Error('expected the row inside its collapse wrapper');
    return wrapper;
}

describe('ListRowShell', () => {
    it('can be the list item of a real <ul>, so the list keeps its list semantics', () => {
        render(
            <ul>
                <ListRowShell as="li" itemId="a">
                    Alpha
                </ListRowShell>
            </ul>,
        );
        expect(screen.getAllByRole('listitem')).toHaveLength(1);
        expect(collapseWrapperOf('Alpha').tagName).toBe('LI');
    });

    it('marks the scroll-restoration anchor on a live row and never consumes it', () => {
        const onGhostExited = vi.fn();
        render(
            <ListRowShell itemId="a" onGhostExited={onGhostExited}>
                Alpha
            </ListRowShell>,
        );
        expect(screen.getByText('Alpha').closest('[data-list-item-id="a"]')).not.toBeNull();
        act(() => vi.advanceTimersByTime(5000));
        expect(onGhostExited).not.toHaveBeenCalled();
    });

    it('shows a ghost inert, collapses it after the linger, then reports it gone', () => {
        const onGhostExited = vi.fn();
        render(
            <ListRowShell itemId="a" isGhost onGhostExited={onGhostExited}>
                Alpha
            </ListRowShell>,
        );
        expect(screen.getByTestId('ghostListRow').hasAttribute(GHOST_ROW_ATTR)).toBe(true);
        expect(collapseWrapperOf('Alpha').hasAttribute('data-collapsing')).toBe(false);

        act(() => vi.advanceTimersByTime(700));
        expect(collapseWrapperOf('Alpha').hasAttribute('data-collapsing')).toBe(true);
        expect(onGhostExited).not.toHaveBeenCalled();

        act(() => vi.advanceTimersByTime(200));
        expect(onGhostExited).toHaveBeenCalledWith('a');
    });

    it('lingers again when a row that came back is ghosted a second time', () => {
        const { rerender } = render(
            <ListRowShell itemId="a" isGhost>
                Alpha
            </ListRowShell>,
        );
        act(() => vi.advanceTimersByTime(800));
        rerender(
            <ListRowShell itemId="a" isGhost={false}>
                Alpha
            </ListRowShell>,
        );
        rerender(
            <ListRowShell itemId="a" isGhost>
                Alpha
            </ListRowShell>,
        );
        expect(collapseWrapperOf('Alpha').hasAttribute('data-collapsing')).toBe(false);
        act(() => vi.advanceTimersByTime(700));
        expect(collapseWrapperOf('Alpha').hasAttribute('data-collapsing')).toBe(true);
    });

    it('re-expands a row that comes back after its collapse already started', () => {
        const { rerender } = render(
            <ListRowShell itemId="a" isGhost>
                Alpha
            </ListRowShell>,
        );
        act(() => vi.advanceTimersByTime(800));
        expect(collapseWrapperOf('Alpha').hasAttribute('data-collapsing')).toBe(true);
        rerender(
            <ListRowShell itemId="a" isGhost={false}>
                Alpha
            </ListRowShell>,
        );
        expect(collapseWrapperOf('Alpha').hasAttribute('data-collapsing')).toBe(false);
    });

    it('cancels the collapse when the row comes back before it finishes', () => {
        const onGhostExited = vi.fn();
        const { rerender } = render(
            <ListRowShell itemId="a" isGhost onGhostExited={onGhostExited}>
                Alpha
            </ListRowShell>,
        );
        act(() => vi.advanceTimersByTime(300));
        rerender(
            <ListRowShell itemId="a" isGhost={false} onGhostExited={onGhostExited}>
                Alpha
            </ListRowShell>,
        );
        act(() => vi.advanceTimersByTime(5000));
        expect(onGhostExited).not.toHaveBeenCalled();
    });
});
