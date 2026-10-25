import type { Meta, StoryObj } from '@storybook/react';
import { Spinner } from './Spinner';

const meta = {
    title: 'Design System/Spinner',
    component: Spinner,
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AccentTone: Story = {};
export const Small: Story = { args: { size: 16 } };
/** Takes the surrounding text colour — the spinner inside a loading Button. */
export const InheritTone: Story = {
    args: { tone: 'inherit' },
    render: (args) => (
        <span style={{ color: 'var(--color-status-error)' }}>
            <Spinner {...args} />
        </span>
    ),
};
export const Labelled: Story = { args: { label: 'Syncing' } };
