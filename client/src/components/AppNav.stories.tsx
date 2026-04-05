import type { Meta, StoryObj } from '@storybook/react';
import { fn } from '@storybook/test';
import { useState } from 'react';
import { RouterDecorator } from '../../.storybook/RouterDecorator';
import { mockDb } from '../test-utils/storybookMocks';
import { AppNav } from './AppNav';

const meta = {
    title: 'Components/AppNav',
    component: AppNav,
    parameters: { layout: 'fullscreen' },
    tags: ['autodocs'],
    decorators: [RouterDecorator],
    args: {
        isMobileDrawerOpen: false,
        db: mockDb,
        setIsMobileDrawerOpen: fn(),
    },
} satisfies Meta<typeof AppNav>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Desktop layout — the permanent sidebar drawer is always visible.
 * The temporary mobile drawer is closed.
 */
export const DesktopDrawerOpen: Story = {
    args: { isMobileDrawerOpen: false },
    parameters: {
        viewport: { defaultViewport: 'desktop' },
    },
};

/**
 * Mobile layout with the drawer open — the temporary drawer slides in from the left.
 */
export const MobileDrawerOpen: Story = {
    args: { isMobileDrawerOpen: true },
    parameters: {
        viewport: { defaultViewport: 'mobile1' },
    },
};

/**
 * Mobile layout with the drawer closed — only the bottom navigation is visible.
 */
export const MobileDrawerClosed: Story = {
    args: { isMobileDrawerOpen: false },
    parameters: {
        viewport: { defaultViewport: 'mobile1' },
    },
};

/**
 * Interactive version — the drawer toggle button and bottom-nav "More" button
 * open and close the mobile drawer.
 */
export const Interactive: Story = {
    render: (args) => {
        const [open, setOpen] = useState(false);
        return <AppNav {...args} isMobileDrawerOpen={open} setIsMobileDrawerOpen={setOpen} />;
    },
    parameters: {
        viewport: { defaultViewport: 'mobile1' },
    },
};
