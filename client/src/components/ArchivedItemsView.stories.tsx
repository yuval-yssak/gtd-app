import type { Meta, StoryObj } from '@storybook/react';
import { CircleCheck } from 'lucide-react';
import { expect, fn, within } from 'storybook/test';
import { RouterDecorator } from '../../.storybook/RouterDecorator';
import { editorProvidersDecorator } from '../test-utils/storybookAppData';
import { samplePeople, sampleRoutine, sampleWorkContexts } from '../test-utils/storybookMocks';
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
    // What each item was before it was done — the row's context line.
    doneItem('done-5', 'Dentist check-up', '2026-10-01T15:00:00.000Z', {
        statusBeforeDone: 'calendar',
        timeStart: '2026-10-01T14:00:00',
        timeEnd: '2026-10-01T15:00:00',
        location: 'Smile Clinic',
    }),
    doneItem('done-6', 'Signed contract from the landlord', '2026-09-28T10:00:00.000Z', {
        statusBeforeDone: 'waitingFor',
        waitingForPersonId: 'person-2',
        expectedBy: '2026-09-30',
    }),
    doneItem('done-7', 'Call the bank about the card', '2026-09-25T10:00:00.000Z', {
        statusBeforeDone: 'nextAction',
        workContextIds: ['ctx-2'],
        peopleIds: ['person-1'],
        energy: 'low',
    }),
];

const meta = {
    title: 'Components/ArchivedItemsView',
    component: ArchivedItemsView,
    parameters: { layout: 'padded' },
    decorators: [
        editorProvidersDecorator({
            items: doneItems,
            allItems: doneItems,
            routines: [sampleRoutine],
            allRoutines: [sampleRoutine],
            allPeople: samplePeople,
            allWorkContexts: sampleWorkContexts,
        }),
        RouterDecorator,
    ],
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

/**
 * A populated archive — count chip, sort menu, and rows (one routine-generated, one cancelled in
 * Calendar). The last three carry a context line: what each item was before it was done.
 */
export const List: Story = {
    play: async ({ canvasElement }) => {
        const summaries = await within(canvasElement).findAllByTestId('doneItemContextSummary');
        await expect(summaries.map((summary) => summary.textContent)).toEqual([
            'Calendar · Thu, Oct 1 · 2:00 pm – 3:00 pm · Smile Clinic',
            'Waiting For · Bob Smith · Sep 30, 2026',
            'Next Action · Near phone · Alice Johnson',
        ]);
    },
};

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
