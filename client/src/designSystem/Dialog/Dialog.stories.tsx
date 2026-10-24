import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { Button } from '../Button/Button';
import { TextField } from '../TextField/TextField';
import { AlertDialog, Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from './Dialog';

const meta = {
    title: 'Design System/Dialog',
    component: Dialog,
    args: { open: true, onClose: fn(), children: null },
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ShortForm: Story = {
    args: {
        size: 'xs',
        fullWidth: true,
        children: (
            <>
                <DialogTitle>Rename context</DialogTitle>
                <DialogContent>
                    <TextField label="Name" defaultValue="Phone" fullWidth autoFocus />
                </DialogContent>
                <DialogActions>
                    <Button tone="neutral">Cancel</Button>
                    <Button variant="solid">Save</Button>
                </DialogActions>
            </>
        ),
    },
};

export const SystemNotice: Story = {
    args: {
        children: (
            <>
                <DialogTitle>Full sync required</DialogTitle>
                <DialogContent>
                    <DialogDescription>This device was offline long enough that its history was cleaned up on the server.</DialogDescription>
                </DialogContent>
                <DialogActions>
                    <Button>Export</Button>
                    <Button tone="danger">Discard &amp; full sync</Button>
                    <Button variant="solid">Push my offline changes</Button>
                </DialogActions>
            </>
        ),
    },
};

export const LongContent: Story = {
    args: {
        size: 'sm',
        fullWidth: true,
        children: (
            <>
                <DialogTitle>Sync issues</DialogTitle>
                <DialogContent>
                    {Array.from({ length: 40 }, (_, index) => (
                        <p key={index}>Failed push #{index + 1} — calendar event not found.</p>
                    ))}
                </DialogContent>
                <DialogActions>
                    <Button>Close</Button>
                </DialogActions>
            </>
        ),
    },
};

export const Confirmation: Story = {
    render: () => (
        <AlertDialog open onClose={fn()} size="xs">
            <DialogTitle>Delete routine?</DialogTitle>
            <DialogContent>
                <DialogDescription>Its future items are moved to the trash. Past items stay where they are.</DialogDescription>
            </DialogContent>
            <DialogActions>
                <Button tone="neutral">Cancel</Button>
                <Button variant="solid" tone="danger">
                    Delete
                </Button>
            </DialogActions>
        </AlertDialog>
    ),
};
