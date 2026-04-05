import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { mockDb, sampleInboxItem, sampleNextActionItem, sampleNextActionWithNotes } from '../test-utils/storybookMocks';
import { EditItemDialog } from './EditItemDialog';

const meta = {
    title: 'Components/EditItemDialog',
    component: EditItemDialog,
    parameters: { layout: 'fullscreen' },
    tags: ['autodocs'],
    args: {
        db: mockDb,
        onClose: fn(),
        onSaved: fn().mockResolvedValue(undefined),
    },
} satisfies Meta<typeof EditItemDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Inbox item with a title only — notes area is blank. */
export const InboxItem: Story = {
    args: { item: sampleInboxItem },
};

/** Item with markdown notes — the preview tab is available to render the markdown. */
export const WithMarkdownNotes: Story = {
    args: { item: sampleNextActionWithNotes },
};

/** A nextAction item — same dialog but with a different status. */
export const NextActionItem: Story = {
    args: { item: sampleNextActionItem },
};
