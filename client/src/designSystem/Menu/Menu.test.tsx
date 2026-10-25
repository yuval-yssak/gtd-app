// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isModalOpen } from '../../lib/keyboardRegionDom';
import { Button } from '../Button/Button';
import { IconButton } from '../IconButton/IconButton';
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
