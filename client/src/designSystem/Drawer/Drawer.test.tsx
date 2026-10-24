// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isModalOpen, KEYBOARD_REGION_ATTR } from '../../lib/keyboardRegionDom';
import { Button } from '../Button/Button';
import { Drawer } from './Drawer';

afterEach(cleanup);

function NavHarness() {
    const [isOpen, setIsOpen] = useState(false);
    return (
        <>
            <Button onClick={() => setIsOpen(true)}>Open menu</Button>
            <Drawer open={isOpen} onClose={() => setIsOpen(false)} aria-label="Navigation">
                <nav {...{ [KEYBOARD_REGION_ATTR]: '' }} aria-label="Main">
                    <a href="/inbox">Inbox</a>
                </nav>
            </Drawer>
        </>
    );
}

describe('Drawer', () => {
    it('renders nothing while closed, so a closed drawer’s keyboard region is not in the DOM', () => {
        render(<NavHarness />);
        expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
        expect(isModalOpen()).toBe(false);
    });

    it('opens as a named modal dialog that silences page shortcuts', async () => {
        render(<NavHarness />);
        await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));
        expect(await screen.findByRole('dialog', { name: 'Navigation' })).toBeDefined();
        expect(screen.getByRole('link', { name: 'Inbox' })).toBeDefined();
        expect(isModalOpen()).toBe(true);
    });

    it('closes on Escape and leaves the DOM', async () => {
        render(<NavHarness />);
        await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));
        await screen.findByRole('dialog');
        await userEvent.keyboard('{Escape}');
        await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(isModalOpen()).toBe(false);
    });

    it('names a bottom sheet from its title', async () => {
        render(
            <Drawer open onClose={vi.fn()} side="bottom" title="Move to…">
                <Button>Someday</Button>
            </Drawer>,
        );
        expect(await screen.findByRole('dialog', { name: 'Move to…' })).toBeDefined();
    });
});
