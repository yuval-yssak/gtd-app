// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isModalOpen } from '../../lib/keyboardRegionDom';
import { Button } from '../Button/Button';
import { IconButton } from '../IconButton/IconButton';
import { Popover } from '../Popover/Popover';
import { Select } from '../Select/Select';
import { MenuCheckboxItem, MenuItem, MenuPopup, MenuRoot, MenuTrigger } from './Menu';

afterEach(cleanup);

describe('Menu', () => {
    function AccountsMenu({ onSignOut = vi.fn() }) {
        return (
            <MenuRoot>
                <MenuTrigger
                    render={
                        <IconButton aria-label="Accounts menu" data-testid="accountSwitcherTrigger">
                            <svg />
                        </IconButton>
                    }
                />
                <MenuPopup>
                    <MenuItem onClick={onSignOut}>Sign out</MenuItem>
                </MenuPopup>
            </MenuRoot>
        );
    }

    it('opens from a DS IconButton trigger that keeps its own name and test id', async () => {
        render(<AccountsMenu />);
        const trigger = screen.getByTestId('accountSwitcherTrigger');
        expect(trigger).toBe(screen.getByRole('button', { name: 'Accounts menu' }));
        await userEvent.click(trigger);
        expect(await screen.findByRole('menu')).toBeDefined();
        expect(isModalOpen()).toBe(true);
    });

    it('runs a menuitem’s onClick and closes', async () => {
        const onSignOut = vi.fn();
        render(<AccountsMenu onSignOut={onSignOut} />);
        await userEvent.click(screen.getByRole('button', { name: 'Accounts menu' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
        expect(onSignOut).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    });

    it('keeps the menu open while toggling a checkbox item', async () => {
        function ColumnsMenu() {
            const [isShown, setIsShown] = useState(false);
            return (
                <MenuRoot>
                    <MenuTrigger render={<Button>Columns</Button>} />
                    <MenuPopup>
                        <MenuCheckboxItem checked={isShown} onCheckedChange={setIsShown}>
                            Due date
                        </MenuCheckboxItem>
                    </MenuPopup>
                </MenuRoot>
            );
        }
        render(<ColumnsMenu />);
        await userEvent.click(screen.getByRole('button', { name: 'Columns' }));
        const item = await screen.findByRole('menuitemcheckbox', { name: 'Due date' });
        await userEvent.click(item);
        expect(item.getAttribute('aria-checked')).toBe('true');
        expect(screen.getByRole('menu')).toBeDefined();
    });
});

describe('Popover', () => {
    it('hangs off an anchor element, is an open modal, and closes on Escape', async () => {
        const onClose = vi.fn();
        function Harness() {
            const [anchor, setAnchor] = useState<HTMLElement | null>(null);
            return (
                <>
                    <Button onClick={(event) => setAnchor(event.currentTarget)}>Pick date</Button>
                    <Popover open={anchor !== null} anchor={anchor} onClose={onClose} aria-label="Date picker">
                        <button type="button">Today</button>
                    </Popover>
                </>
            );
        }
        render(<Harness />);
        await userEvent.click(screen.getByRole('button', { name: 'Pick date' }));
        expect(await screen.findByRole('button', { name: 'Today' })).toBeDefined();
        expect(isModalOpen()).toBe(true);
        await userEvent.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

describe('Select', () => {
    it('is a combobox named by its label with option roles (e2e: combobox { name: "Calendar" })', async () => {
        const onValueChange = vi.fn();
        render(
            <Select
                label="Calendar"
                value="work"
                onValueChange={onValueChange}
                options={[
                    { value: 'work', label: 'Work' },
                    { value: 'home', label: 'Home' },
                ]}
            />,
        );
        const trigger = screen.getByRole('combobox', { name: 'Calendar' });
        expect(trigger.textContent).toContain('Work');
        await userEvent.click(trigger);
        await userEvent.click(await screen.findByRole('option', { name: 'Home' }));
        expect(onValueChange).toHaveBeenCalledWith('home');
    });

    it('counts as an open modal while its list is open, and closes on Escape', async () => {
        render(
            <Select
                label="Calendar"
                value="work"
                onValueChange={vi.fn()}
                options={[
                    { value: 'work', label: 'Work' },
                    { value: 'home', label: 'Home' },
                ]}
            />,
        );
        await userEvent.click(screen.getByRole('combobox', { name: 'Calendar' }));
        await screen.findByRole('listbox');
        expect(isModalOpen()).toBe(true);
        await userEvent.keyboard('{Escape}');
        await vi.waitFor(() => expect(isModalOpen()).toBe(false));
    });
});
