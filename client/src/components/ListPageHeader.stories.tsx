import type { Meta, StoryObj } from '@storybook/react';
import { Plus } from 'lucide-react';
import { Button } from '../designSystem';
import { ListEmptyMessage } from './ListEmptyMessage';
import { ListPageHeader } from './ListPageHeader';

const meta = {
    title: 'Components/ListPageHeader',
    component: ListPageHeader,
    parameters: { layout: 'padded' },
} satisfies Meta<typeof ListPageHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A list with live rows: the count chip follows the title. */
export const WithCount: Story = { args: { title: 'Inbox', count: 12, countTone: 'accent' } };

/** An empty list: no chip at zero. */
export const Empty: Story = { args: { title: 'Tickler', count: 0 } };

/** A trailing action at the inline-end edge. */
export const WithAction: Story = {
    args: {
        title: 'People',
        count: 4,
        action: (
            <Button startIcon={<Plus />} variant="solid" size="sm">
                Add person
            </Button>
        ),
    },
};

/** The empty-list note that goes with it. */
export const EmptyMessage: StoryObj = {
    render: () => <ListEmptyMessage>Inbox zero — well done.</ListEmptyMessage>,
};
