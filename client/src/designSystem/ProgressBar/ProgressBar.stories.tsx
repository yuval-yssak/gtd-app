import type { Meta, StoryObj } from '@storybook/react';
import { ProgressBar } from './ProgressBar';

const meta = {
    title: 'Design System/ProgressBar',
    component: ProgressBar,
    args: { value: 60, 'aria-label': 'Uploading' },
    parameters: { layout: 'padded' },
} satisfies Meta<typeof ProgressBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Determinate: Story = {};
export const Empty: Story = { args: { value: 0 } };
export const Complete: Story = { args: { value: 100 } };
export const Indeterminate: Story = { args: { value: null, 'aria-label': 'Syncing' } };
/** The `span` parts, for a bar inside a button; it must lay out exactly like the div one. */
export const InsideButton: Story = {
    args: { value: null, as: 'span', 'aria-label': 'Syncing' },
    render: (args) => (
        <button type="button" style={{ display: 'grid', gap: '0.25rem', inlineSize: '12rem' }}>
            Syncing
            <ProgressBar {...args} />
        </button>
    ),
};
