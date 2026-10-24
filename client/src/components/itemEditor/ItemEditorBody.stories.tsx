import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { RouterDecorator } from '../../../.storybook/RouterDecorator';
import { editorProvidersDecorator } from '../../test-utils/storybookAppData';
import {
    mockDb,
    sampleCalendarItem,
    sampleInboxItem,
    sampleNextActionItem,
    sampleNextActionWithNotes,
    samplePeople,
    sampleWaitingForItem,
    sampleWorkContexts,
} from '../../test-utils/storybookMocks';
import { ItemEditorBody } from './ItemEditorBody';

// The item editor as the item page hosts it (the page header and card are the page's).
const meta = {
    title: 'Components/ItemEditorBody',
    component: ItemEditorBody,
    parameters: { layout: 'padded' },
    tags: ['autodocs'],
    decorators: [editorProvidersDecorator({ allPeople: samplePeople, allWorkContexts: sampleWorkContexts }), RouterDecorator],
    args: {
        db: mockDb,
        people: samplePeople,
        workContexts: sampleWorkContexts,
        onClose: fn(),
        onSaved: fn().mockResolvedValue(undefined),
        item: sampleInboxItem,
    },
} satisfies Meta<typeof ItemEditorBody>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Inbox item with a title only — the notes section starts in the editor. */
export const InboxItem: Story = {};

/** Item with Markdown notes — they rest in the read-only preview behind the pencil. */
export const WithMarkdownNotes: Story = {
    args: { item: sampleNextActionWithNotes },
};

/** A next action — energy, time and context fields under the selected status chip. */
export const NextActionItem: Story = {
    args: { item: sampleNextActionItem },
};

/** A calendar item — date and start/end time fields for rescheduling. */
export const CalendarItem: Story = {
    args: { item: sampleCalendarItem },
};

/** A waiting-for item — the person selector plus expected-by and ignore-before dates. */
export const WaitingForItem: Story = {
    args: { item: sampleWaitingForItem },
};

/** An inbox item opened from a status chip — the editor opens preset to that status. */
export const PresetFromChip: Story = {
    args: { initialStatus: 'calendar' },
};
