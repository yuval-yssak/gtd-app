import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, within } from 'storybook/test';
import { Card } from '../../designSystem';
import { editorProvidersDecorator } from '../../test-utils/storybookAppData';
import { mockDb, sampleWorkContexts } from '../../test-utils/storybookMocks';
import type { StoredAccount } from '../../types/MyDB';
import { WorkContextEditorBody } from './WorkContextEditorBody';

const [sampleContext] = sampleWorkContexts;
if (!sampleContext) {
    throw new Error('storybookMocks must provide at least one sample work context');
}

const blankContext = { ...sampleContext, name: '' };

const twoAccounts: StoredAccount[] = [
    { id: 'user-1', email: 'me@example.com', name: 'Me', image: null, provider: 'google', addedAt: 1 },
    { id: 'user-2', email: 'me@work.example.com', name: 'Me at work', image: null, provider: 'github', addedAt: 2 },
];

const meta = {
    title: 'Work Contexts/WorkContextEditorBody',
    component: WorkContextEditorBody,
    decorators: [
        // The body reads the unfiltered list; without it the context looks remotely deleted.
        editorProvidersDecorator({ workContexts: sampleWorkContexts, allWorkContexts: sampleWorkContexts }),
        // The /work-context/$workContextId page renders the body inside a card.
        (Story) => (
            <Card>
                <Story />
            </Card>
        ),
    ],
    args: { db: mockDb, workContext: sampleContext, chrome: 'page', onClose: fn() },
} satisfies Meta<typeof WorkContextEditorBody>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Page chrome: the name field is not auto-focused — the page is read-mostly, like the person page. */
export const PageChrome: Story = {
    play: async ({ canvasElement }) => {
        const nameInput = within(canvasElement).getByTestId('workContextEditName').querySelector('input');
        await expect(nameInput).not.toHaveFocus();
    },
};

/** A blank name is never saved; the field says so. */
export const PageEmptyName: Story = {
    args: { workContext: blankContext },
    // The provider must list the blank row too, or the live merge adopts the stored name on mount.
    decorators: [editorProvidersDecorator({ workContexts: [blankContext], allWorkContexts: [blankContext] })],
    play: async ({ canvasElement }) => {
        await expect(await within(canvasElement).findByText(/Name is required/)).toBeVisible();
    },
};

/** Multi-account device: the account picker appears under the name, to move the context to another account. */
export const PageMultiAccount: Story = {
    decorators: [
        editorProvidersDecorator({
            workContexts: sampleWorkContexts,
            allWorkContexts: sampleWorkContexts,
            loggedInAccounts: twoAccounts,
            loggedInUserIds: twoAccounts.map((account) => account.id),
        }),
    ],
};
