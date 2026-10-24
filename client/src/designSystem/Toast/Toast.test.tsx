// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isModalOpen } from '../../lib/keyboardRegionDom';
import { Button } from '../Button/Button';
import { Toast } from './Toast';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

function region() {
    return screen.getByRole('status');
}

describe('Toast', () => {
    it('renders nothing while closed', () => {
        render(<Toast open={false} message="Saved" />);
        expect(screen.queryByText('Saved')).toBeNull();
    });

    it('appears inside a persistent polite live region — never as role="dialog", which e2e counts as an open dialog', () => {
        const { rerender } = render(<Toast open={false} message="Saved" />);
        // The region exists before any toast content arrives, so the arrival is announced.
        expect(region().textContent).toBe('');
        rerender(<Toast open message="Saved" />);
        expect(within(region()).getByText('Saved')).toBeDefined();
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('announces an error assertively as well', () => {
        render(<Toast open tone="error" message="Could not save" />);
        expect(screen.getByRole('alert').textContent).toBe('Could not save');
    });

    it('does not count as an open modal, so page shortcuts keep working under it', () => {
        render(<Toast open message="Saved" />);
        expect(isModalOpen()).toBe(false);
    });

    it('closes after autoHideDuration with reason "timeout"', () => {
        const onClose = vi.fn();
        render(<Toast open message="Saved" autoHideDuration={3000} onClose={onClose} />);
        act(() => vi.advanceTimersByTime(2999));
        expect(onClose).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(1));
        expect(onClose).toHaveBeenCalledWith('timeout');
    });

    it('pauses the timer while the pointer is over it and restarts on leave', () => {
        const onClose = vi.fn();
        render(<Toast open message="Saved" autoHideDuration={3000} onClose={onClose} data-testid="toast" />);
        const toast = screen.getByTestId('toast');
        act(() => vi.advanceTimersByTime(2000));
        fireEvent.pointerEnter(toast);
        act(() => vi.advanceTimersByTime(10_000));
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.pointerLeave(toast);
        act(() => vi.advanceTimersByTime(3000));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('pauses while focus is on its action, then resumes after focus leaves', () => {
        const onClose = vi.fn();
        render(<Toast open message="Saved" autoHideDuration={3000} onClose={onClose} action={<Button>Undo</Button>} />);
        act(() => screen.getByRole('button', { name: 'Undo' }).focus());
        act(() => vi.advanceTimersByTime(10_000));
        expect(onClose).not.toHaveBeenCalled();

        act(() => screen.getByRole('button', { name: 'Undo' }).blur());
        act(() => vi.advanceTimersByTime(3000));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    // Undo/× closes the toast under the pointer, so no pointerleave ever arrives; the next showing
    // must still auto-dismiss.
    it('starts fresh when reopened after closing while hovered', () => {
        const onClose = vi.fn();
        const { rerender } = render(<Toast open message="Saved" autoHideDuration={3000} onClose={onClose} data-testid="toast" />);
        fireEvent.pointerEnter(screen.getByTestId('toast'));
        rerender(<Toast open={false} message="Saved" autoHideDuration={3000} onClose={onClose} data-testid="toast" />);
        rerender(<Toast open message="Saved again" autoHideDuration={3000} onClose={onClose} data-testid="toast" />);
        act(() => vi.advanceTimersByTime(3000));
        expect(onClose).toHaveBeenCalledWith('timeout');
    });

    it('closes from its close button with reason "closeButton"', () => {
        const onClose = vi.fn();
        render(<Toast open dismissible message="Saved" onClose={onClose} />);
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledWith('closeButton');
    });

    it('stacks two open toasts in the one region', () => {
        render(
            <>
                <Toast open message="Saved" />
                <Toast open message="Moved" />
            </>,
        );
        expect(within(region()).getByText('Saved')).toBeDefined();
        expect(within(region()).getByText('Moved')).toBeDefined();
    });
});
