import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';

const meta = {
    title: 'Components/UnsavedChangesDialog',
    component: UnsavedChangesDialog,
    args: { blocker: { isBlocked: true, stay: fn(), discard: fn() } },
} satisfies Meta<typeof UnsavedChangesDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A navigation was paused over unsaved edits — "Keep editing" holds focus. */
export const Blocked: Story = {};
