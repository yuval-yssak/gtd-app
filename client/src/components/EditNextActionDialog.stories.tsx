import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { RouterDecorator } from '../../.storybook/RouterDecorator';
import { mockDb, sampleInboxItem, sampleNextActionItem, sampleNextActionWithNotes, samplePeople, sampleWorkContexts } from '../test-utils/storybookMocks';
import { EditNextActionDialog } from './EditNextActionDialog';

const meta = {
    title: 'Components/EditNextActionDialog',
    component: EditNextActionDialog,
    parameters: { layout: 'fullscreen' },
    tags: ['autodocs'],
    decorators: [RouterDecorator],
    args: {
        db: mockDb,
        people: samplePeople,
        workContexts: sampleWorkContexts,
        onClose: fn(),
        onSaved: fn().mockResolvedValue(undefined),
    },
} satisfies Meta<typeof EditNextActionDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Next action with minimal metadata — no contexts, people, or dates filled in. */
export const MinimalNextAction: Story = {
    args: {
        // Use sampleInboxItem with a status override — avoids having to set optional fields to
        // undefined which violates exactOptionalPropertyTypes.
        item: { ...sampleInboxItem, status: 'nextAction' as const },
    },
};

/** Next action with all metadata fields filled — energy, time, focus, urgent, dates, contexts, people. */
export const FullyDecoratedNextAction: Story = {
    args: { item: sampleNextActionItem },
};

/** No people or work contexts configured in the system. */
export const NoPeopleOrContexts: Story = {
    args: {
        item: sampleNextActionItem,
        people: [],
        workContexts: [],
    },
};

/** Item with markdown notes — shows the edit/preview tab pair. */
export const WithMarkdownNotes: Story = {
    args: { item: sampleNextActionWithNotes },
};
