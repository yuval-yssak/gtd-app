import type { Meta, StoryObj } from '@storybook/react';
import { CircleCheck } from 'lucide-react';
import { fn } from 'storybook/test';
import { RouterDecorator } from '../../.storybook/RouterDecorator';
import { editorProvidersDecorator } from '../test-utils/storybookAppData';
import { sampleRoutine } from '../test-utils/storybookMocks';
import type { StoredItem } from '../types/MyDB';
import { ArchivedItemsView } from './ArchivedItemsView';

const doneItem = (id: string, title: string, updatedTs: string, extra: Partial<StoredItem> = {}): StoredItem => ({
    _id: id,
    userId: 'user-1',
    status: 'done',
    title,
    createdTs: '2026-09-01T09:00:00.000Z',
    updatedTs,
    ...extra,
});

const doneItems = [
    doneItem('done-1', 'Send the signed lease back', '2026-10-24T16:00:00.000Z'),
    doneItem('done-2', 'Weekly team sync', '2026-10-20T10:00:00.000Z', { routineId: sampleRoutine._id }),
    doneItem('done-3', 'Quarterly planning meeting', '2026-10-18T09:00:00.000Z', { cancelledByGCal: true }),
    doneItem('done-4', 'Renew the passport', '2026-10-02T12:00:00.000Z'),
];

const meta = {
    title: 'Components/ArchivedItemsView',
    component: ArchivedItemsView,
    parameters: { layout: 'padded' },
    decorators: [editorProvidersDecorator({ items: doneItems, allItems: doneItems, routines: [sampleRoutine], allRoutines: [sampleRoutine] }), RouterDecorator],
    args: {
        status: 'done',
        title: 'Done',
        emptyIcon: <CircleCheck />,
        emptyMessage: 'Nothing completed yet.',
        urlQuery: '',
        writeUrlQuery: fn(),
    },
} satisfies Meta<typeof ArchivedItemsView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A populated archive — count chip, sort menu, and rows (one routine-generated, one cancelled in Calendar). */
export const List: Story = {};

/** The search query matches nothing — the header stays, the rows give way to a no-matches line. */
export const NoMatches: Story = {
    args: { urlQuery: 'zzz' },
};

/** A truly empty archive — the empty-state card. */
export const Empty: Story = {
    decorators: [editorProvidersDecorator()],
};

/** Empty during the first-launch bootstrap — "not loaded yet", so the skeleton instead of the empty card. */
export const Skeleton: Story = {
    decorators: [editorProvidersDecorator({ isInitialSyncing: true })],
};
