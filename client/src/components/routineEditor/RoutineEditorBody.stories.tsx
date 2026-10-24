import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { RouterDecorator } from '../../../.storybook/RouterDecorator';
import { editorProvidersDecorator } from '../../test-utils/storybookAppData';
import { mockDb, sampleCalendarRoutine, samplePeople, sampleRoutine, sampleWorkContexts } from '../../test-utils/storybookMocks';
import { RoutineEditorBody } from './RoutineEditorBody';

// The routine editor as /routine/new and /routine/:id host it (the page header and card are the page's).
const meta = {
    title: 'Components/RoutineEditorBody',
    component: RoutineEditorBody,
    parameters: { layout: 'padded' },
    tags: ['autodocs'],
    decorators: [editorProvidersDecorator(), RouterDecorator],
    args: {
        db: mockDb,
        userId: 'user-1',
        workContexts: sampleWorkContexts,
        people: samplePeople,
        onClose: fn(),
        onSaved: fn().mockResolvedValue(undefined),
        onCreated: fn(),
    },
} satisfies Meta<typeof RoutineEditorBody>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Create mode (the /routine/new page) — a blank next-action routine with the title focused. */
export const CreateNextAction: Story = {};

/** Edit an existing next-action routine — the form is pre-populated. */
export const EditExistingNextAction: Story = {
    args: { routine: sampleRoutine },
};

/** Edit an existing calendar routine — time-of-day, duration and the calendar picker. */
export const EditExistingCalendar: Story = {
    args: { routine: sampleCalendarRoutine },
};

/** Create mode with no people or work contexts — the context and people pickers render empty. */
export const NoPeopleOrContexts: Story = {
    args: { workContexts: [], people: [] },
};
