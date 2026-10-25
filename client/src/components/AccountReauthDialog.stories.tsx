import type { Meta, StoryObj } from '@storybook/react';
import type { IDBPDatabase } from 'idb';
import { expect, waitFor, within } from 'storybook/test';
import { flagAccountNeedsReauth, resetAccountReauthStore } from '../contexts/accountReauthEvents';
import { mockDb } from '../test-utils/storybookMocks';
import type { MyDB, StoredAccount } from '../types/MyDB';
import { AccountReauthDialog } from './AccountReauthDialog';

const staleAccount: StoredAccount = { id: 'user-2', email: 'work@example.com', name: 'Work', image: null, provider: 'google', addedAt: 2 };

// Same shape as mockDb (a typed stub, no storage), but the accounts store holds the stale account
// so the dialog can name it instead of falling back to "Unknown account".
const dbWithAccounts = { ...mockDb, getAll: async () => [staleAccount] } as unknown as IDBPDatabase<MyDB>;

const flagStaleAccount = () => {
    flagAccountNeedsReauth(staleAccount.id);
    return () => resetAccountReauthStore();
};

/** Pins navigator.onLine to false for one story (useOnline reads it on render). */
function goOffline() {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    return () => {
        // Removing the own property re-exposes the prototype getter.
        Reflect.deleteProperty(navigator, 'onLine');
    };
}

const meta = {
    title: 'Components/AccountReauthDialog',
    component: AccountReauthDialog,
    args: { db: dbWithAccounts },
} satisfies Meta<typeof AccountReauthDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** An account lost its session — the blocking dialog names it with an enabled Re-login. */
export const Open: Story = {
    beforeEach: flagStaleAccount,
    play: async () => {
        const dialog = await within(document.body).findByTestId('accountReauthDialog');
        await waitFor(() => expect(within(dialog).getByText(staleAccount.email)).toBeVisible());
        await expect(within(dialog).getByTestId('accountReauthDialogRelogin')).toBeEnabled();
    },
};

/** Offline — the dialog explains why Re-login (an OAuth redirect) is disabled. */
export const Offline: Story = {
    beforeEach: () => {
        const restoreOnline = goOffline();
        const resetFlags = flagStaleAccount();
        return () => {
            resetFlags();
            restoreOnline();
        };
    },
    play: async () => {
        const dialog = await within(document.body).findByTestId('accountReauthDialog');
        await waitFor(() => expect(within(dialog).getByTestId('accountReauthDialogOfflineHint')).toBeVisible());
        await expect(within(dialog).getByTestId('accountReauthDialogRelogin')).toBeDisabled();
    },
};
