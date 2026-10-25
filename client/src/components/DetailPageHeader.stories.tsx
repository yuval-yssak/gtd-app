import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { DetailPageHeader } from './DetailPageHeader';

const meta = {
    title: 'Components/DetailPageHeader',
    component: DetailPageHeader,
    parameters: { layout: 'padded' },
    tags: ['autodocs'],
    args: { onBack: fn() },
} satisfies Meta<typeof DetailPageHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An edit page — the entity's id can be copied. */
export const Edit: Story = {
    args: { title: 'Edit routine', idForCopy: 'routine-1' },
};

/** A create page — nothing to copy yet. */
export const Create: Story = {
    args: { title: 'New routine' },
};
