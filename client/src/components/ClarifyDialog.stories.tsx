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

/** Single inbox item — wizard still shows the 1 of 1 counter and the Skip button. */
export const SingleItem: Story = {
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

/** No people or work contexts in the system — form renders without those chips. */
export const NoExtraMetadata: Story = {
    args: {
        items: [sampleInboxItem],
        people: [],
        workContexts: [],
    },
};
