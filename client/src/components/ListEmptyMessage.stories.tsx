import type { Meta, StoryObj } from '@storybook/react';
import { ListEmptyMessage } from './ListEmptyMessage';

const meta = {
    title: 'Components/ListEmptyMessage',
    component: ListEmptyMessage,
    parameters: { layout: 'padded' },
} satisfies Meta<typeof ListEmptyMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An empty list, or a search with no matches. */
export const Default: Story = { args: { children: 'Inbox zero — well done.' } };
