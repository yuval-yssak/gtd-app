import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import {
    mockDb,
    sampleCalendarItem,
    sampleInboxItem,
    sampleNextActionItem,
    sampleNextActionWithNotes,
    samplePeople,
    sampleWaitingForItem,
    sampleWorkContexts,
} from '../test-utils/storybookMocks';
import { EditItemDialog } from './EditItemDialog';

const meta = {
    title: 'Components/EditItemDialog',
    component: EditItemDialog,
    parameters: { layout: 'fullscreen' },
    tags: ['autodocs'],
    args: {
        db: mockDb,
        people: samplePeople,
        workContexts: sampleWorkContexts,
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

/** A nextAction item — same dialog but with a different status chip selected. */
export const NextActionItem: Story = {
    args: { item: sampleNextActionItem },
};

/** A calendar item — exposes date + start/end time pickers for rescheduling. */
export const CalendarItem: Story = {
    args: { item: sampleCalendarItem },
};

/** A waiting-for item — exposes the person selector + expected-by and ignore-before dates. */
export const WaitingForItem: Story = {
    args: { item: sampleWaitingForItem },
};
