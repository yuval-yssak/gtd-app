import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { RouterDecorator } from '../../../.storybook/RouterDecorator';
import { editorProvidersDecorator } from '../../test-utils/storybookAppData';
import { mockDb, sampleCalendarItem, samplePeople } from '../../test-utils/storybookMocks';
import type { StoredItem } from '../../types/MyDB';
import { MeetingDetails } from './MeetingDetails';

const MEETING: StoredItem = {
    ...sampleCalendarItem,
    organizer: { email: 'olive@example.com', displayName: 'Olive Organizer' },
    attendees: [
        { email: 'me@example.com', responseStatus: 'accepted', self: true },
        { email: 'alice@example.com', displayName: 'Alice Johnson', responseStatus: 'declined' },
        { email: 'guest@example.com', responseStatus: 'tentative' },
        { email: 'later@example.com', responseStatus: 'needsAction' },
    ],
};

async function expand(canvasElement: HTMLElement) {
    const summary = within(canvasElement).getByTestId('meetingDetailsSummary');
    await userEvent.click(summary);
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
}

const meta = {
    title: 'Components/MeetingDetails',
    component: MeetingDetails,
    parameters: { layout: 'padded' },
    tags: ['autodocs'],
    decorators: [editorProvidersDecorator({ people: samplePeople }), RouterDecorator],
    args: { item: MEETING, db: mockDb, onRsvp: fn().mockResolvedValue(undefined), onAttendeesChange: fn().mockResolvedValue(undefined) },
} satisfies Meta<typeof MeetingDetails>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Collapsed: the organizer and the response tally only. */
export const Collapsed: Story = {};

/** Expanded: attendee chips tinted by RSVP (yours bold, not removable), the picker, and the RSVP buttons. */
export const Expanded: Story = {
    play: async ({ canvasElement }) => expand(canvasElement),
};

/** Typing in the picker: matching people, and the typed text offered as a new email. */
export const AttendeeSuggestions: Story = {
    play: async ({ canvasElement }) => {
        await expand(canvasElement);
        await userEvent.type(within(canvasElement).getByRole('combobox', { name: 'Add attendee' }), 'alice@example.org');
        await within(document.body).findByText('Add alice@example.org');
    },
};

/** A routine occurrence: changing the attendees first asks before detaching it from the series. */
export const DetachWarning: Story = {
    args: { item: { ...MEETING, routineId: 'routine-1' } },
    play: async ({ canvasElement }) => {
        await expand(canvasElement);
        await userEvent.click(within(canvasElement).getByRole('button', { name: 'Remove guest@example.com' }));
        await within(document.body).findByTestId('detachWarningText');
    },
};

/** The weekly review's routine card: chips only — no picker, no remove, no RSVP. */
export const ReadOnly: Story = {
    args: { readOnly: true },
    play: async ({ canvasElement }) => expand(canvasElement),
};

/** Google needs more permissions before an RSVP can be sent. */
export const NeedsReconsent: Story = {
    args: { scopeMissingReconsentUrl: 'https://accounts.google.com/o/oauth2/auth', onReconsentClosed: fn() },
    play: async ({ canvasElement }) => expand(canvasElement),
};
