import type { Meta, StoryObj } from '@storybook/react';
import { Button } from '../Button/Button';
import { Badge } from './Badge';

const meta = {
    title: 'Design System/Badge',
    component: Badge,
    args: { count: 7 },
    parameters: { layout: 'padded' },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Inline: Story = {};
/** Sits on the corner of the element it counts for (the nav's Inbox entry). */
export const Anchored: Story = { args: { children: <Button variant="outline">Inbox</Button> } };
/** Above 99 the count reads "99+". */
export const Capped: Story = { args: { count: 120 } };
export const AccentTone: Story = { args: { tone: 'accent' } };
export const ErrorTone: Story = { args: { tone: 'error' } };
export const WarningTone: Story = { args: { tone: 'warning' } };
export const NeutralTone: Story = { args: { tone: 'neutral' } };
