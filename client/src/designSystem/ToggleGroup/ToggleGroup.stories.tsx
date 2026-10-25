import type { Meta, StoryObj } from '@storybook/react';
import { fn, userEvent } from 'storybook/test';
import { ToggleGroup } from './ToggleGroup';

const ENDS = [
    { value: 'never', label: 'Never' },
    { value: 'on', label: 'On date' },
    { value: 'after', label: 'After' },
] as const;

const meta = {
    title: 'Design System/ToggleGroup',
    component: ToggleGroup<'never' | 'on' | 'after'>,
    args: { 'aria-label': 'Ends', value: 'never', onValueChange: fn(), options: ENDS },
} satisfies Meta<typeof ToggleGroup<'never' | 'on' | 'after'>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Exclusive: Story = {};
export const Medium: Story = { args: { size: 'md' } };
/** `allowDeselect` with nothing chosen: no segment is pressed. */
export const DeselectableEmpty: Story = {
    render: () => <ToggleGroup aria-label="Energy filter" allowDeselect value="" onValueChange={fn()} options={ENDS} />,
};
export const Disabled: Story = { args: { disabled: true } };
export const Focused: Story = {
    play: async () => {
        await userEvent.tab();
    },
};
