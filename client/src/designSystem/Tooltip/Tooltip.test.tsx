// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../Button/Button';
import { Dialog, DialogTitle } from '../Dialog/Dialog';
import { IconButton } from '../IconButton/IconButton';
import { Tooltip } from './Tooltip';

const listenerCleanups: Array<() => void> = [];

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    for (const removeListener of listenerCleanups.splice(0)) removeListener();
});

/**
 * A page-level Escape handler like usePageEscapeToClose: a key some widget already claimed
 * (preventDefault) does not count. Removed after each test, even one that times out mid-way.
 */
function watchPageEscape() {
    const onPageEscape = vi.fn();
    const listener = (event: KeyboardEvent) => event.key === 'Escape' && !event.defaultPrevented && onPageEscape();
    document.addEventListener('keydown', listener);
    listenerCleanups.push(() => document.removeEventListener('keydown', listener));
    return onPageEscape;
}

describe('Tooltip', () => {
    it('names an unlabelled trigger with a string title (MUI parity)', () => {
        render(
            <Tooltip title="Archive">
                <button type="button">
                    <svg />
                </button>
            </Tooltip>,
        );
        expect(screen.getByRole('button', { name: 'Archive' })).toBeDefined();
    });

    it('keeps the trigger’s own aria-label', () => {
        render(
            <Tooltip title="Edit (e)">
                <IconButton aria-label="Edit">
                    <svg />
                </IconButton>
            </Tooltip>,
        );
        expect(screen.getByRole('button', { name: 'Edit' })).toBeDefined();
    });

    it('opens on hover with role="tooltip" showing exactly the title, then closes on leave', async () => {
        const user = userEvent.setup();
        render(
            <Tooltip title="Edit (e)">
                <IconButton aria-label="Edit">
                    <svg />
                </IconButton>
            </Tooltip>,
        );
        await user.hover(screen.getByRole('button'));
        expect((await screen.findByRole('tooltip')).textContent).toBe('Edit (e)');

        await user.unhover(screen.getByRole('button'));
        await vi.waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    });

    it('opens within MUI’s 100ms enter delay', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(
            <Tooltip title="Save">
                <Button>Save</Button>
            </Tooltip>,
        );
        await user.hover(screen.getByRole('button'));
        await act(async () => {
            vi.advanceTimersByTime(120);
        });
        expect(screen.queryByRole('tooltip')).not.toBeNull();
    });

    it('opens on keyboard focus', async () => {
        const user = userEvent.setup();
        render(
            <Tooltip title="Edit (e)">
                <IconButton aria-label="Edit">
                    <svg />
                </IconButton>
            </Tooltip>,
        );
        await user.tab();
        expect(await screen.findByRole('tooltip')).toBeDefined();
    });

    it('closes on Escape and still lets the key reach the page (MUI parity: page Escape-to-leave)', async () => {
        const user = userEvent.setup();
        const onPageEscape = watchPageEscape();
        render(
            <Tooltip title="Edit (e)">
                <IconButton aria-label="Edit">
                    <svg />
                </IconButton>
            </Tooltip>,
        );
        await user.tab();
        await screen.findByRole('tooltip');
        await user.keyboard('{Escape}');
        expect(onPageEscape).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    });

    it('inside an open dialog, Escape closes the dialog and the page never sees it', async () => {
        const user = userEvent.setup();
        const onPageEscape = watchPageEscape();
        const onDialogClose = vi.fn();
        render(
            <Dialog open onClose={onDialogClose}>
                <DialogTitle>Edit</DialogTitle>
                <Tooltip title="Edit (e)">
                    <IconButton aria-label="Edit">
                        <svg />
                    </IconButton>
                </Tooltip>
            </Dialog>,
        );
        screen.getByRole('button', { name: 'Edit' }).focus();
        await screen.findByRole('tooltip');
        await user.keyboard('{Escape}');
        expect(onDialogClose).toHaveBeenCalledTimes(1);
        // The dialog claimed the key; letting it propagate past the tooltip must not leave the page.
        expect(onPageEscape).not.toHaveBeenCalled();
    });

    it('still shows for a disabled button wrapped in a span', async () => {
        const user = userEvent.setup();
        render(
            <Tooltip title="Nothing to save">
                <span>
                    <Button disabled>Save</Button>
                </span>
            </Tooltip>,
        );
        await user.hover(screen.getByText('Save').closest('span') as HTMLElement);
        expect((await screen.findByRole('tooltip')).textContent).toBe('Nothing to save');
    });

    it('does not name a wrapper span (aria-label on a generic element is prohibited)', () => {
        render(
            <Tooltip title="Nothing to save">
                <span data-testid="wrapper">
                    <Button disabled>Save</Button>
                </span>
            </Tooltip>,
        );
        expect(screen.getByTestId('wrapper').hasAttribute('aria-label')).toBe(false);
        expect(screen.getByRole('button', { name: 'Save' })).toBeDefined();
    });

    it('keeps an aria-labelledby name', () => {
        render(
            <>
                <span id="label">Archive item</span>
                <Tooltip title="Archive">
                    <button type="button" aria-labelledby="label">
                        <svg />
                    </button>
                </Tooltip>
            </>,
        );
        expect(screen.getByRole('button', { name: 'Archive item' })).toBeDefined();
    });

    it('does not open from a touch tap (information for phones must not live only in a tooltip)', async () => {
        const user = userEvent.setup();
        render(
            <Tooltip title="Edit (e)">
                <IconButton aria-label="Edit">
                    <svg />
                </IconButton>
            </Tooltip>,
        );
        await user.pointer({ keys: '[TouchA]', target: screen.getByRole('button') });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    // A title that empties while the tooltip shows (a hint that only applies in some states) must
    // not leave it latched open: when the title returns, nothing is hovering any more.
    it('does not reopen by itself when an emptied title comes back', async () => {
        const user = userEvent.setup();
        const withTitle = (title: string) => (
            <Tooltip title={title}>
                <IconButton aria-label="Edit">
                    <svg />
                </IconButton>
            </Tooltip>
        );
        const { rerender } = render(withTitle('Edit (e)'));
        await user.hover(screen.getByRole('button'));
        await screen.findByRole('tooltip');

        rerender(withTitle(''));
        await user.unhover(screen.getByRole('button'));
        rerender(withTitle('Edit (e)'));

        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('renders the bare child when the title is empty', () => {
        render(
            <Tooltip title="">
                <Button>Save</Button>
            </Tooltip>,
        );
        expect(screen.getByRole('button', { name: 'Save' })).toBeDefined();
    });
});
