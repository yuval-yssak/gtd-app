import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { DoneItemContextSection } from './DoneItemContextSection';

const meta = {
    title: 'Item Editor/DoneItemContextSection',
    component: DoneItemContextSection,
    parameters: { layout: 'padded' },
} satisfies Meta<typeof DoneItemContextSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A done calendar event — its start and end lead, then where and with whom. */
export const CalendarEvent: Story = {
    args: {
        context: {
            status: 'calendar',
            statusLabel: 'Calendar',
            isInferred: false,
            facts: [
                { label: 'When', value: 'Tue, Oct 27 · 2:00 pm – 3:30 pm' },
                { label: 'Location', value: 'Smile Clinic' },
                { label: 'People', value: 'Alice Johnson' },
            ],
        },
    },
    play: async ({ canvasElement }) => {
        await expect(within(canvasElement).getByTestId('doneItemContextStatus')).toHaveTextContent('Calendar');
    },
};

/** A done waiting-for — whom it waited on, and when it was expected. */
export const WaitingFor: Story = {
    args: {
        context: {
            status: 'waitingFor',
            statusLabel: 'Waiting For',
            isInferred: false,
            facts: [
                { label: 'Waiting for', value: 'Bob Smith' },
                { label: 'Expected by', value: 'Nov 3, 2026' },
            ],
        },
    },
};

/** A done next action — contexts and people first, then energy and time. */
export const NextAction: Story = {
    args: {
        context: {
            status: 'nextAction',
            statusLabel: 'Next Action',
            isInferred: false,
            facts: [
                { label: 'Contexts', value: 'Near phone, At computer' },
                { label: 'People', value: 'Alice Johnson' },
                { label: 'Energy', value: 'Low' },
                { label: 'Time', value: '15 min' },
            ],
        },
    },
};

/** Completed before the status was recorded — deduced from the item's leftover fields, and said so. */
export const InferredStatus: Story = {
    args: {
        context: {
            status: 'calendar',
            statusLabel: 'Calendar',
            isInferred: true,
            facts: [{ label: 'When', value: 'Tue, Oct 27 · all day' }],
        },
    },
    play: async ({ canvasElement }) => {
        await expect(within(canvasElement).getByTestId('doneItemContextStatus')).toHaveTextContent('inferred from its details');
    },
};

/** The prior status cannot be told apart, but the item kept some details — no status line, just the facts. */
export const UnknownStatus: Story = {
    args: {
        context: { status: null, statusLabel: null, isInferred: true, facts: [{ label: 'People', value: 'Carol Davis' }] },
    },
    play: async ({ canvasElement }) => {
        await expect(within(canvasElement).queryByTestId('doneItemContextStatus')).toBeNull();
    },
};

/** Recorded status with no details worth showing (a captured thought done straight from the inbox). */
export const StatusOnly: Story = {
    args: { context: { status: 'inbox', statusLabel: 'Inbox', isInferred: false, facts: [] } },
};
