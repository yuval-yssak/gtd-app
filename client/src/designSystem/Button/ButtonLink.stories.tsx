import type { Meta, StoryObj } from '@storybook/react';
import { Link } from '@tanstack/react-router';
import { Settings } from 'lucide-react';
import { userEvent } from 'storybook/test';
import { RouterDecorator } from '../../../.storybook/RouterDecorator';
import { ButtonLink } from './ButtonLink';

const meta = {
    title: 'Design System/ButtonLink',
    component: ButtonLink,
    // A router `<Link>` needs a router context to resolve its href.
    decorators: [RouterDecorator],
    args: { render: <Link to="/" />, children: 'Open settings' },
} satisfies Meta<typeof ButtonLink>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ghost: Story = {};
export const Solid: Story = { args: { variant: 'solid' } };
export const Outline: Story = { args: { variant: 'outline' } };
export const WithStartIcon: Story = { args: { variant: 'outline', startIcon: <Settings /> } };
/** Without `render` it is a plain `<a>`. */
export const PlainAnchor: Story = { args: { render: undefined, href: '#', variant: 'outline' } };
export const Focused: Story = {
    args: { variant: 'solid' },
    play: async () => {
        await userEvent.tab();
    },
};
