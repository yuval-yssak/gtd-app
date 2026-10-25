import type { Meta, StoryObj } from '@storybook/react';
import { Separator } from './Separator';

const meta = {
    title: 'Design System/Separator',
    component: Separator,
    parameters: { layout: 'padded' },
    render: (args) => (
        <div>
            <p>Above the line</p>
            <Separator {...args} />
            <p>Below the line</p>
        </div>
    ),
} satisfies Meta<typeof Separator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {};
