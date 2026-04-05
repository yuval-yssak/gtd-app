import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { mockDb, sampleInboxItem, samplePeople, sampleWorkContexts } from '../test-utils/storybookMocks';
import type { StoredItem } from '../types/MyDB';
import { ClarifyDialog } from './ClarifyDialog';

const meta = {
    title: 'Components/ClarifyDialog',
    component: ClarifyDialog,
    parameters: { layout: 'fullscreen' },
    tags: ['autodocs'],
    args: {
        db: mockDb,
        people: samplePeople,
        workContexts: sampleWorkContexts,
        onClose: fn(),
        onItemProcessed: fn().mockResolvedValue(undefined),
    },
} satisfies Meta<typeof ClarifyDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Single inbox item — user hasn't selected a destination yet. */
export const SingleInboxItem: Story = {
    args: { items: [sampleInboxItem] },
};

/** Three inbox items — the progress counter (1 / 3) is visible at the top. */
export const MultipleItems: Story = {
    args: {
        items: [
            sampleInboxItem,
            { ...sampleInboxItem, _id: 'item-2', title: 'Call the dentist' },
            { ...sampleInboxItem, _id: 'item-3', title: 'Buy birthday gift for Mom' },
        ] satisfies StoredItem[],
    },
};

/** Next Action destination pre-selected — full form with people and contexts. */
export const PreselectedNextAction: Story = {
    args: {
        items: [sampleInboxItem],
        initialDestination: 'nextAction',
    },
};

/** Calendar destination pre-selected — date/time form shown immediately. */
export const PreselectedCalendar: Story = {
    args: {
        items: [sampleInboxItem],
        initialDestination: 'calendar',
    },
};

/** Waiting For destination pre-selected — person selector shown immediately. */
export const PreselectedWaitingFor: Story = {
    args: {
        items: [sampleInboxItem],
        initialDestination: 'waitingFor',
    },
};

/** Done destination pre-selected — marks the item complete immediately. */
export const PreselectedDone: Story = {
    args: {
        items: [sampleInboxItem],
        initialDestination: 'done',
    },
};

/** Trash destination pre-selected — discards the item. */
export const PreselectedTrash: Story = {
    args: {
        items: [sampleInboxItem],
        initialDestination: 'trash',
    },
};

/** No people or work contexts in the system — form renders without those chips. */
export const NoExtraMetadata: Story = {
    args: {
        items: [sampleInboxItem],
        initialDestination: 'nextAction',
        people: [],
        workContexts: [],
    },
};
