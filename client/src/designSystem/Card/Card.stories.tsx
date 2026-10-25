import type { Meta, StoryObj } from '@storybook/react';
import { Card } from './Card';

const meta = {
    title: 'Design System/Card',
    component: Card,
    args: { children: 'A surface set apart from the page by a hairline.' },
    parameters: { layout: 'padded' },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultPadding: Story = {};
export const SmallPadding: Story = { args: { padding: 'sm' } };
/** The caller lays the content out itself (a list of rows edge to edge). */
export const NoPadding: Story = { args: { padding: 'none' } };
