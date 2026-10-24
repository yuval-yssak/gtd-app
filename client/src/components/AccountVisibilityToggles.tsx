import { EyeOff } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { ensureHiddenAccountsCrossTabBridge, getHiddenAccountIds, subscribeHiddenAccounts, toggleAccountHidden } from '../contexts/hiddenAccounts';
import { IconButton, Tooltip } from '../designSystem';
import type { RovingRegionApi } from '../hooks/useRovingRegion';
import { getAccountColor } from '../lib/accountColors';
import type { StoredAccount } from '../types/MyDB';
import { AccountAvatar } from './AccountAvatar';
import styles from './AccountVisibilityToggles.module.css';

// Module-scope install (not in render) so the window listener side effect never runs during a
// render pass — same placement as ensureAccountReauthBridge in AccountReauthBanner.
ensureHiddenAccountsCrossTabBridge();

interface Props {
    accounts: StoredAccount[];
    /** The accounts region's item props: the avatars leave the tab order and ←/→ walk them. */
    itemProps: RovingRegionApi['itemProps'];
}

/**
 * One-click visibility toggles — one ringed avatar per signed-in account. Clicking an avatar
 * hides/shows that account's data across the whole app (display-only: sync keeps running and
 * mutations still write under the active account). Hidden accounts render dimmed with an eye-off
 * marker. Self-suppresses on single-account devices, mirroring AccountChip.
 */
export function AccountVisibilityToggles({ accounts, itemProps }: Props) {
    const hiddenUserIds = useSyncExternalStore(subscribeHiddenAccounts, getHiddenAccountIds);
    if (accounts.length <= 1) {
        return null;
    }

    return (
        <span className={styles.toggleRow}>
            {accounts.map((account) => {
                const isHidden = hiddenUserIds.includes(account.id);
                const label = isHidden ? `Show ${account.email}'s items` : `Hide ${account.email}'s items`;
                // The ring colour is the account's runtime palette pick.
                const ringStyle = { '--account-color': getAccountColor(account.id, accounts) };
                return (
                    <Tooltip key={account.id} title={label}>
                        <IconButton
                            size="sm"
                            onClick={() => toggleAccountHidden(account.id)}
                            aria-label={label}
                            aria-pressed={isHidden}
                            data-testid={`accountVisibilityToggle-${account.id}`}
                            data-account-hidden={isHidden}
                            {...itemProps}
                        >
                            <span className={styles.avatarSlot}>
                                <span className={styles.avatarRing} data-hidden={isHidden || undefined} style={ringStyle}>
                                    <AccountAvatar account={account} size={22} />
                                </span>
                                {isHidden && (
                                    <span className={styles.hiddenMarker} aria-hidden="true">
                                        <EyeOff size={12} />
                                    </span>
                                )}
                            </span>
                        </IconButton>
                    </Tooltip>
                );
            })}
        </span>
    );
}
