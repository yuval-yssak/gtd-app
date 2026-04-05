import type { Meta, StoryObj } from '@storybook/react';
import { RouterDecorator } from '../../.storybook/RouterDecorator';
import { setRoutineIndicatorStyle } from '../lib/routineIndicatorStyle';
import { RoutineIndicator } from './RoutineIndicator';

const meta = {
    title: 'Components/RoutineIndicator',
    component: RoutineIndicator,
    parameters: { layout: 'centered' },
    tags: ['autodocs'],
    decorators: [RouterDecorator],
    args: { routineId: 'routine-1' },
} satisfies Meta<typeof RoutineIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default icon style with a routine title shown in the tooltip. */
export const IconWithTitle: Story = {
    args: { routineTitle: 'Morning standup' },
    decorators: [
        (Story) => {
            setRoutineIndicatorStyle('icon');
            return <Story />;
        },
    ],
};

/** Icon style without a title — tooltip shows generic "Part of a routine" text. */
export const IconWithoutTitle: Story = {
    decorators: [
        (Story) => {
            setRoutineIndicatorStyle('icon');
            return <Story />;
        },
    ],
};

/** Chip style — displays a labelled chip with the loop icon. */
export const ChipStyle: Story = {
    args: { routineTitle: 'Weekly review' },
    decorators: [
        (Story) => {
            setRoutineIndicatorStyle('chip');
            return <Story />;
        },
    ],
};

/** Color accent style — a small color-coded button used as a compact visual indicator. */
export const ColorAccentStyle: Story = {
    args: { routineTitle: 'Daily exercise' },
    decorators: [
        (Story) => {
            setRoutineIndicatorStyle('colorAccent');
            return <Story />;
        },
    ],
};

/** None style — renders nothing. The canvas will be empty, confirming the null return. */
export const NoneStyle: Story = {
    decorators: [
        (Story) => {
            setRoutineIndicatorStyle('none');
            return <Story />;
        },
    ],
};
