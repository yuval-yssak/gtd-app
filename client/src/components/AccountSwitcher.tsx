import type { IDBPDatabase } from 'idb';
import { Check, LogOut, Plus } from 'lucide-react';
import { IconButton, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRoot, MenuSeparator, MenuTrigger, Spinner, Text, Toast } from '../designSystem';
import { type PendingAction, useAccounts } from '../hooks/useAccounts';
import { useOnline } from '../hooks/useOnline';
import { useRovingRegion } from '../hooks/useRovingRegion';
import type { MyDB } from '../types/MyDB';
import { AccountAvatar } from './AccountAvatar';
import styles from './AccountSwitcher.module.css';
import { AccountVisibilityToggles } from './AccountVisibilityToggles';

const PENDING_LABELS: Record<PendingAction, string> = {
    switching: 'Switching account…',
    signingOut: 'Signing out…',
    signingOutAll: 'Signing out of all accounts…',
};

const MENU_ICON_SIZE = 18;

interface Props {
    db: IDBPDatabase<MyDB>;
}

export function AccountSwitcher({ db }: Props) {
    const { activeAccount, allAccounts, addAnotherAccount, switchToAccount, signOutCurrent, signOutAll, pendingAction, actionError, dismissActionError } =
        useAccounts(db);
    const isOnline = useOnline();
    const isPending = pendingAction !== null;
    // The avatars (visibility toggles + the switcher) are ONE tab stop; ←/→ walk them.
    const accountsRegion = useRovingRegion({ orientation: 'horizontal', label: 'Accounts' });
    const isNetworkActionDisabled = !isOnline || isPending;

    return (
        <>
            {/* Per-account show/hide toggles — rendered here so every AccountSwitcher mount point
                (sidebar footer + mobile app bar) gets them without an extra useAccounts fetch. */}
            <span role="toolbar" className={styles.accountsRegion} data-testid="accountsRegion" {...accountsRegion.regionProps}>
                <AccountVisibilityToggles accounts={allAccounts} itemProps={accountsRegion.itemProps} />
                <MenuRoot>
                    <MenuTrigger
                        render={
                            <IconButton
                                size="sm"
                                className={styles.menuButton}
                                aria-label="Accounts menu"
                                data-testid="accountSwitcherTrigger"
                                {...accountsRegion.itemProps}
                            >
                                <AccountAvatar account={activeAccount} size={32} />
                            </IconButton>
                        }
                    />
                    <MenuPopup>
                        {/* Switching accounts is local-first (IDB write + reload — see useAccounts) so it
                            stays enabled offline. Add-account and sign-out genuinely need the network
                            (OAuth redirect / Better Auth teardown), so those stay blocked below — this
                            note explains why. A group label (naming the account list), not a disabled item: disabled items are
                            skipped by screen-reader menu navigation, hiding the explanation from AT. */}
                        <MenuGroup>
                            {!isOnline && (
                                <MenuGroupLabel data-testid="accountSwitcherOfflineNote">
                                    Offline — adding accounts and signing out need a connection
                                </MenuGroupLabel>
                            )}
                            {allAccounts.map((account) => (
                                <MenuItem
                                    key={account.id}
                                    data-testid={`accountSwitcherItem-${account.id}`}
                                    disabled={isPending}
                                    leading={<AccountAvatar account={account} size={24} />}
                                    description={account.email}
                                    // Checkmark on the currently active account
                                    trailing={account.id === activeAccount?.id ? <Check size={MENU_ICON_SIZE} className={styles.checkIcon} /> : undefined}
                                    onClick={() => {
                                        if (account.id !== activeAccount?.id) {
                                            void switchToAccount(account.id);
                                        }
                                    }}
                                >
                                    {account.name}
                                </MenuItem>
                            ))}
                        </MenuGroup>
                        <MenuSeparator />
                        <MenuItem disabled={isNetworkActionDisabled} leading={<Plus size={MENU_ICON_SIZE} />} onClick={() => addAnotherAccount('google')}>
                            Add Google account
                        </MenuItem>
                        <MenuItem disabled={isNetworkActionDisabled} leading={<Plus size={MENU_ICON_SIZE} />} onClick={() => addAnotherAccount('github')}>
                            Add GitHub account
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem disabled={isNetworkActionDisabled} leading={<LogOut size={MENU_ICON_SIZE} />} onClick={() => void signOutCurrent()}>
                            Sign out
                        </MenuItem>
                        <MenuItem disabled={isNetworkActionDisabled} leading={<LogOut size={MENU_ICON_SIZE} />} onClick={() => void signOutAll()}>
                            Sign out all accounts
                        </MenuItem>
                    </MenuPopup>
                </MenuRoot>
            </span>

            {/*
                Blocking overlay while account-change requests are in flight. The async chain
                (signOutDevice + Better Auth signOut + setActive) takes a few seconds and ends in
                a hard navigation, so without this the UI looks frozen. aria-busy/aria-live announce
                the in-flight state to screen readers, which otherwise just hear silence during the gap.
            */}
            {isPending && (
                <div className={styles.pendingOverlay} data-testid="accountActionBackdrop" aria-busy="true" aria-live="polite">
                    <Spinner tone="inherit" size={40} label={PENDING_LABELS[pendingAction]} />
                    <Text variant="body" tone="inherit">
                        {PENDING_LABELS[pendingAction]}
                    </Text>
                </div>
            )}

            {/*
                Surfaces failures from withPending in useAccounts. Without this, a failed sign-out
                drops the overlay and leaves the user staring at a still-signed-in app with no
                clue what happened.
            */}
            <Toast
                open={actionError !== null}
                tone="error"
                dismissible
                autoHideDuration={6000}
                onClose={dismissActionError}
                message={actionError}
                data-testid="accountActionError"
            />
        </>
    );
}
