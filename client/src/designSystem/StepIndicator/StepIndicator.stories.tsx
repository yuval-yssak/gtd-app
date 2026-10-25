import type { Meta, StoryObj } from '@storybook/react';
import { fn, userEvent } from 'storybook/test';
import { StepIndicator } from './StepIndicator';

const STAGES = ['Collect', 'Inbox', 'Calendar', 'Waiting For', 'Projects'];

const meta = {
    title: 'Design System/StepIndicator',
    component: StepIndicator,
    args: {
        'aria-label': 'Weekly review',
        activeIndex: 2,
        steps: STAGES.map((label) => ({ key: label, label })),
        onStepSelected: fn(),
    },
} satisfies Meta<typeof StepIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Selectable: Story = {};
/** Without `onStepSelected` the steps are plain text, not buttons. */
export const ReadOnly: Story = {
    render: ({ onStepSelected: _onStepSelected, ...args }) => <StepIndicator {...args} />,
};

/** Walked in any order: completion comes from each step, not from its position. */
export const AnyOrder: Story = {
    args: { activeIndex: 1, steps: STAGES.map((label, index) => ({ key: label, label, isComplete: index === 3 })) },
};

/** The current step is also complete (an empty stage): it keeps the solid current fill and a readable number. */
export const CurrentAlsoComplete: Story = {
    args: { activeIndex: 1, steps: STAGES.map((label, index) => ({ key: label, label, isComplete: index <= 1 })) },
};

/** Labels under the markers: eight steps share a narrow strip, scrolling only below a readable width. */
export const LabelsBelow: Story = {
    args: {
        labelPlacement: 'below',
        steps: [...STAGES, 'Next Actions', 'Someday / Maybe', 'Final sweep'].map((label) => ({ key: label, label })),
    },
};

export const FocusedStep: Story = {
    play: async () => {
        await userEvent.tab();
    },
};
