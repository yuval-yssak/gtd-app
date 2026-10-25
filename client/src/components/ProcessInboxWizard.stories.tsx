import type { Meta, StoryObj } from '@storybook/react';
import { type ComponentProps, useEffect } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { RouterDecorator } from '../../.storybook/RouterDecorator';
import { usePendingReassign } from '../contexts/PendingReassignProvider';
import { editorProvidersDecorator } from '../test-utils/storybookAppData';
import { mockDb, sampleInboxItem, samplePeople, sampleWorkContexts } from '../test-utils/storybookMocks';
import type { StoredItem } from '../types/MyDB';
import { ProcessInboxWizard } from './ProcessInboxWizard';

const inboxItems: StoredItem[] = [
    sampleInboxItem,
    { ...sampleInboxItem, _id: 'item-inbox-2', title: 'Call the dentist about the crown', notes: 'Ask whether **Thursday** works.' },
    { ...sampleInboxItem, _id: 'item-inbox-3', title: 'Look into a new bike lock' },
];
const [firstItem] = inboxItems;

const urlOf = (input: RequestInfo | URL) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

/** Holds every POST /sync/reassign open forever, so a started move stays in flight for the story. */
function hangReassignRequests() {
    const realFetch = window.fetch;
    window.fetch = (input, init) => (urlOf(input).includes('/sync/reassign') ? new Promise<Response>(() => {}) : realFetch(input, init));
    return () => {
        window.fetch = realFetch;
    };
}

/** Starts a cross-account move of the first item on mount (through the real overlay), then renders the wizard. */
function WizardWithFirstItemMoving(props: ComponentProps<typeof ProcessInboxWizard>) {
    const { runReassignWithOverlay } = usePendingReassign();
    useEffect(() => {
        if (!firstItem) return;
        void runReassignWithOverlay({
            kind: 'item',
            entityId: firstItem._id,
            label: firstItem.title,
            override: { toUserId: 'user-2' },
            params: { entityType: 'item', entityId: firstItem._id, fromUserId: 'user-1', toUserId: 'user-2' },
        });
    }, [runReassignWithOverlay]);
    return <ProcessInboxWizard {...props} />;
}

const meta = {
    title: 'Components/ProcessInboxWizard',
    component: ProcessInboxWizard,
    parameters: { layout: 'fullscreen' },
    decorators: [editorProvidersDecorator({ allPeople: samplePeople, allWorkContexts: sampleWorkContexts, items: inboxItems }), RouterDecorator],
    args: {
        items: inboxItems,
        db: mockDb,
        people: samplePeople,
        workContexts: sampleWorkContexts,
        onClose: fn(),
        onItemProcessed: fn().mockResolvedValue(undefined),
    },
} satisfies Meta<typeof ProcessInboxWizard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The first of three items in the full editor — "Save & next", "Skip for now", "Exit". */
export const AnItem: Story = {
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(within(canvasElement).getByTestId('processInboxSaveNext')).toBeVisible());
    },
};

/** Two skips later — the last item, whose actions read "Save & finish" / "Skip & finish". */
export const LastItem: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await userEvent.click(await canvas.findByTestId('processInboxSkip'));
        await userEvent.click(await canvas.findByTestId('processInboxSkip'));
        await waitFor(() => expect(canvas.getByTestId('processInboxSaveNext')).toHaveTextContent('Save & finish'));
    },
};

/** The current item is mid-move to another account — the editor is withheld, Skip and Exit stay reachable. */
export const ReassignInFlight: Story = {
    beforeEach: hangReassignRequests,
    render: (args) => <WizardWithFirstItemMoving {...args} />,
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(within(canvasElement).getByText(/This item is being moved to another account/)).toBeVisible());
    },
};
