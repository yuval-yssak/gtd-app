import type { Meta, StoryObj } from '@storybook/react';
import { Pencil } from 'lucide-react';
import { userEvent, within } from 'storybook/test';
import { Button } from '../Button/Button';
import { IconButton } from '../IconButton/IconButton';
import { Tooltip } from './Tooltip';

const meta = {
    title: 'Design System/Tooltip',
    component: Tooltip,
    args: {
        title: 'Edit (e)',
        children: (
            <IconButton aria-label="Edit">
                <Pencil />
            </IconButton>
        ),
    },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const OpenOnHover: Story = {
    play: async ({ canvasElement }) => {
        await userEvent.hover(within(canvasElement).getByRole('button'));
        await within(document.body).findByRole('tooltip');
    },
};

export const OpenOnFocus: Story = {
    play: async () => {
        await userEvent.tab();
        await within(document.body).findByRole('tooltip');
    },
};

export const OnDisabledButton: Story = {
    args: {
        title: 'Nothing to save yet',
        children: (
            <span>
                <Button variant="solid" disabled>
                    Save
                </Button>
            </span>
        ),
    },
    play: async ({ canvasElement }) => {
        await userEvent.hover(within(canvasElement).getByText('Save'));
        await within(document.body).findByRole('tooltip');
    },
};
