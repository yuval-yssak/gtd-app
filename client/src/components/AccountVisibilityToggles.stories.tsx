import type { Meta, StoryObj } from '@storybook/react';
import { getHiddenAccountIds, toggleAccountHidden } from '../contexts/hiddenAccounts';
import { ROVING_ITEM_ATTR } from '../lib/keyboardRegionDom';
import type { StoredAccount } from '../types/MyDB';
import { AccountVisibilityToggles } from './AccountVisibilityToggles';

const personalAccount: StoredAccount = { id: 'user-1', email: 'me@example.com', name: 'Me', image: null, provider: 'google', addedAt: 1 };
const workAccount: StoredAccount = { id: 'user-2', email: 'me@work.example.com', name: 'Me at work', image: null, provider: 'github', addedAt: 2 };

/** Sets one account's flag in the shared (localStorage-backed) hidden store; the returned cleanup restores it. */
function setAccountHidden(userId: string, isHidden: boolean) {
    const wasHidden = getHiddenAccountIds().includes(userId);
    if (wasHidden !== isHidden) toggleAccountHidden(userId);
    return () => {
        if (getHiddenAccountIds().includes(userId) !== wasHidden) toggleAccountHidden(userId);
    };
}

/** Arranges the work account's visibility (the personal one always shown) for one story. */
const withWorkAccountHidden = (isHidden: boolean) => () => {
    const restorePersonal = setAccountHidden(personalAccount.id, false);
    const restoreWork = setAccountHidden(workAccount.id, isHidden);
    return () => {
        restoreWork();
        restorePersonal();
    };
};

const meta = {
    title: 'Components/AccountVisibilityToggles',
    component: AccountVisibilityToggles,
    args: { accounts: [personalAccount, workAccount], itemProps: { tabIndex: -1, [ROVING_ITEM_ATTR]: '' } },
} satisfies Meta<typeof AccountVisibilityToggles>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two signed-in accounts, both shown — one ringed avatar each. */
export const TwoAccounts: Story = {
    beforeEach: withWorkAccountHidden(false),
};

/** The work account is hidden — its avatar is dimmed with the eye-off marker and reads as pressed. */
export const OneHidden: Story = {
    beforeEach: withWorkAccountHidden(true),
};

/** A single-account device — the toggles suppress themselves. */
export const SingleAccount: Story = {
    args: { accounts: [personalAccount] },
};
