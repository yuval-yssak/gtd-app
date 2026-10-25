import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { Button } from '../Button/Button';
import { Callout } from './Callout';

const meta = {
    title: 'Design System/Callout',
    component: Callout,
    args: { children: 'Reconnect Google Calendar to keep events in sync.' },
    parameters: { layout: 'padded' },
} satisfies Meta<typeof Callout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Info: Story = {};
export const Success: Story = { args: { tone: 'success', children: 'All caught up.' } };
export const Warning: Story = { args: { tone: 'warning', title: 'Sync is broken', children: 'Sign in again to resume syncing.' } };
export const ErrorTone: Story = { args: { tone: 'error', title: 'Something went wrong', children: 'The page could not load.' } };
export const WithAction: Story = { args: { tone: 'warning', title: 'Sync is broken', action: <Button size="sm">Re-login</Button> } };
export const Dismissible: Story = { args: { tone: 'info', onClose: fn() } };
export const Outline: Story = { args: { tone: 'success', variant: 'outline', children: 'All caught up.' } };
