// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../Button/Button';
import { IconButton } from '../IconButton/IconButton';
import { Tooltip } from './Tooltip';

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

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

    it('renders the bare child when the title is empty', () => {
        render(
            <Tooltip title="">
                <Button>Save</Button>
            </Tooltip>,
        );
        expect(screen.getByRole('button', { name: 'Save' })).toBeDefined();
    });
});
