import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { editorProvidersDecorator } from '../../test-utils/storybookAppData';
import { mockDb, samplePeople } from '../../test-utils/storybookMocks';
import { PersonEditDialog } from './PersonEditDialog';
import { QuickCreatePersonDialog } from './QuickCreatePersonDialog';

const [samplePerson] = samplePeople;
if (!samplePerson) {
    throw new Error('storybookMocks must provide at least one sample person');
}

const meta = {
    title: 'People/Dialogs',
    component: PersonEditDialog,
    decorators: [editorProvidersDecorator({ people: samplePeople, allPeople: samplePeople })],
    args: { db: mockDb, person: samplePerson, onClose: fn() },
} satisfies Meta<typeof PersonEditDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The quick edit dialog: autosaving fields, Close only. */
export const EditPerson: Story = {};

/** "Save as person" from a meeting attendee: the email arrives prefilled. */
export const QuickCreateFromAttendee: StoryObj = {
    render: () => <QuickCreatePersonDialog prefilledEmail="dana@example.com" db={mockDb} ownerUserId="user-1" onCreated={fn()} onCancel={fn()} />,
};
