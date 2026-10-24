import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { RoutinePageHeader } from './RoutinePageHeader';

const meta = {
    title: 'Components/RoutinePageHeader',
    component: RoutinePageHeader,
    parameters: { layout: 'padded' },
    tags: ['autodocs'],
    args: { onBack: fn() },
} satisfies Meta<typeof RoutinePageHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The edit page — the routine's id can be copied. */
export const EditRoutine: Story = {
    args: { title: 'Edit routine', idForCopy: 'routine-1' },
};

/** The create page — no routine yet, so no copy button. */
export const NewRoutine: Story = {
    args: { title: 'New routine' },
};
