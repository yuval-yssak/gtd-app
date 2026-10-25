import type { Meta, StoryObj } from '@storybook/react';
import { Button } from '../Button/Button';
import { ButtonGroup } from './ButtonGroup';

const meta = {
    title: 'Design System/ButtonGroup',
    component: ButtonGroup,
    args: {
        'aria-label': 'Position',
        children: (
            <>
                <Button variant="outline" title="Move to top (Shift+Home)">
                    Top
                </Button>
                <Button variant="outline" title="Move up (Shift+↑)">
                    Up
                </Button>
                <Button variant="outline" title="Move down (Shift+↓)">
                    Down
                </Button>
            </>
        ),
    },
} satisfies Meta<typeof ButtonGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Joined: Story = {};
export const Disabled: Story = { args: { disabled: true } };
