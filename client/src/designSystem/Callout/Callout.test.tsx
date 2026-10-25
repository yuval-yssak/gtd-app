// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Callout, type CalloutTone } from './Callout';

afterEach(cleanup);

describe('Callout', () => {
    // Errors and warnings interrupt (MUI Alert parity); info and success wait their turn.
    it.each<[CalloutTone, string]>([
        ['error', 'alert'],
        ['warning', 'alert'],
        ['info', 'status'],
        ['success', 'status'],
    ])('a %s callout is role="%s"', (tone, role) => {
        render(<Callout tone={tone}>Reconnect Google Calendar</Callout>);
        expect(screen.getByRole(role).textContent).toContain('Reconnect Google Calendar');
    });

    it('offers a Close button that calls onClose', async () => {
        const onClose = vi.fn();
        render(<Callout onClose={onClose}>Saved</Callout>);
        await userEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('has no Close button without onClose', () => {
        render(<Callout>Saved</Callout>);
        expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    });

    it('renders its title and trailing action', () => {
        render(
            <Callout tone="warning" title="Sync is broken" action={<button type="button">Re-login</button>}>
                Sign in again to resume syncing.
            </Callout>,
        );
        const callout = screen.getByRole('alert');
        expect(callout.textContent).toContain('Sync is broken');
        expect(screen.getByRole('button', { name: 'Re-login' })).toBeDefined();
    });
});
