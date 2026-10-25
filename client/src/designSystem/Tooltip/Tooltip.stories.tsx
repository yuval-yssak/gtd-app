import type { Meta, StoryObj } from '@storybook/react';
import { Pencil } from 'lucide-react';
import { fireEvent, userEvent, within } from 'storybook/test';
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

/**
 * Base UI opens a tooltip on the first mousemove over its trigger, as a real pointer always sends;
 * userEvent.hover alone only enters it.
 */
async function hoverLikeAPointer(target: HTMLElement) {
    await userEvent.hover(target);
    fireEvent.mouseMove(target);
}

export const Closed: Story = {};

export const OpenOnHover: Story = {
    play: async ({ canvasElement }) => {
        await hoverLikeAPointer(await within(canvasElement).findByRole('button'));
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
        await hoverLikeAPointer(await within(canvasElement).findByText('Save'));
        await within(document.body).findByRole('tooltip');
    },
};
