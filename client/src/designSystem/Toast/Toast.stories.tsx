import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { Button } from '../Button/Button';
import { Toast } from './Toast';

const meta = {
    title: 'Design System/Toast',
    component: Toast,
    args: { open: true, message: 'Moved to Next Actions', onClose: fn() },
    parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Toast>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Message: Story = {};
export const WithUndo: Story = { args: { message: 'Saved', action: <Button size="sm">Undo</Button> } };
export const WithTwoActions: Story = {
    args: {
        message: 'Saved',
        action: (
            <>
                <Button size="sm">View</Button>
                <Button size="sm">Undo</Button>
            </>
        ),
    },
};
export const ErrorTone: Story = { args: { tone: 'error', message: 'Could not switch accounts', dismissible: true } };
/** Mid-viewport on wide screens too — for a notice about the sidebar's own controls. */
export const Centered: Story = { args: { placement: 'center', message: 'Item captured, but its account is hidden' } };
export const SuccessTone: Story = { args: { tone: 'success', message: 'Copied' } };
export const LongMessage: Story = {
    args: { message: 'Captured to an account you have hidden — show it from the account switcher to see the item in your lists.', dismissible: true },
};
