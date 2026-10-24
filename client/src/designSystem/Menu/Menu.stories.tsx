import type { Meta, StoryObj } from '@storybook/react';
import { Check, LogOut, Plus, UserRound } from 'lucide-react';
import { useState } from 'react';
import { userEvent, within } from 'storybook/test';
import { IconButton } from '../IconButton/IconButton';
import { MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRoot, MenuSeparator, MenuTrigger } from './Menu';

function AccountsMenu({ isOffline = false }: { isOffline?: boolean }) {
    return (
        <MenuRoot>
            <MenuTrigger
                render={
                    <IconButton aria-label="Accounts menu">
                        <UserRound />
                    </IconButton>
                }
            />
            <MenuPopup>
                <MenuGroup>
                    {isOffline && <MenuGroupLabel>Offline — adding accounts and signing out need a connection</MenuGroupLabel>}
                    <MenuItem leading={<UserRound size={20} />} description="me@example.com" trailing={<Check size={16} />}>
                        Personal
                    </MenuItem>
                    <MenuItem leading={<UserRound size={20} />} description="me@work.com">
                        Work
                    </MenuItem>
                </MenuGroup>
                <MenuSeparator />
                <MenuItem leading={<Plus size={18} />} disabled={isOffline}>
                    Add Google account
                </MenuItem>
                <MenuItem leading={<LogOut size={18} />} tone="danger" disabled={isOffline}>
                    Sign out
                </MenuItem>
            </MenuPopup>
        </MenuRoot>
    );
}

const meta = {
    title: 'Design System/Menu',
    component: AccountsMenu,
} satisfies Meta<typeof AccountsMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

const openMenu: Story['play'] = async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Accounts menu' }));
    await within(document.body).findByRole('menu');
};

export const Closed: Story = {};
export const Open: Story = { play: openMenu };
export const OpenOffline: Story = { args: { isOffline: true }, play: openMenu };
export const HighlightedItem: Story = {
    play: async (context) => {
        await openMenu(context);
        await userEvent.keyboard('{ArrowDown}');
    },
};

function ColumnsMenu() {
    const [visible, setVisible] = useState({ due: true, contexts: false });
    return (
        <MenuRoot>
            <MenuTrigger
                render={
                    <IconButton aria-label="Columns">
                        <Check />
                    </IconButton>
                }
            />
            <MenuPopup>
                <MenuCheckboxItem checked={visible.due} onCheckedChange={(due) => setVisible((current) => ({ ...current, due }))}>
                    Due date
                </MenuCheckboxItem>
                <MenuCheckboxItem checked={visible.contexts} onCheckedChange={(contexts) => setVisible((current) => ({ ...current, contexts }))}>
                    Contexts
                </MenuCheckboxItem>
            </MenuPopup>
        </MenuRoot>
    );
}

export const CheckboxItems: StoryObj = {
    render: () => <ColumnsMenu />,
    play: async ({ canvasElement }) => {
        await userEvent.click(within(canvasElement).getByRole('button', { name: 'Columns' }));
        await within(document.body).findByRole('menu');
    },
};
