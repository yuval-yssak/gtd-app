import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import Badge from '@mui/material/Badge';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import classNames from 'classnames';
import { useSyncExternalStore } from 'react';
import { ensureHiddenAccountsCrossTabBridge, getHiddenAccountIds, subscribeHiddenAccounts, toggleAccountHidden } from '../contexts/hiddenAccounts';
import { getAccountColor } from '../lib/accountColors';
import type { StoredAccount } from '../types/MyDB';
import { AccountAvatar } from './AccountAvatar';
import styles from './AccountVisibilityToggles.module.css';

// Module-scope install (not in render) so the window listener side effect never runs during a
// render pass — same placement as ensureAccountReauthBridge in AccountReauthBanner.
ensureHiddenAccountsCrossTabBridge();

interface Props {
    accounts: StoredAccount[];
}

/**
 * One-click visibility toggles — one ringed avatar per signed-in account. Clicking an avatar
 * hides/shows that account's data across the whole app (display-only: sync keeps running and
 * mutations still write under the active account). Hidden accounts render dimmed with an eye-off
 * badge. Self-suppresses on single-account devices, mirroring AccountChip.
 */
export function AccountVisibilityToggles({ accounts }: Props) {
    const hiddenUserIds = useSyncExternalStore(subscribeHiddenAccounts, getHiddenAccountIds);
    if (accounts.length <= 1) {
        return null;
    }

    return (
        <span className={styles.toggleRow}>
            {accounts.map((account) => {
                const isHidden = hiddenUserIds.includes(account.id);
                const label = isHidden ? `Show ${account.email}'s items` : `Hide ${account.email}'s items`;
                return (
                    <Tooltip key={account.id} title={label}>
                        <IconButton
                            size="small"
                            onClick={() => toggleAccountHidden(account.id)}
                            aria-label={label}
                            aria-pressed={isHidden}
                            data-testid={`accountVisibilityToggle-${account.id}`}
                            data-account-hidden={isHidden}
                        >
                            <Badge
                                overlap="circular"
                                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                                badgeContent={<VisibilityOffIcon className={styles.hiddenBadgeIcon} />}
                                invisible={!isHidden}
                            >
                                {/* Inline style: ring colour is per-account, computed from the shared palette at runtime */}
                                <span
                                    className={classNames(styles.avatarRing, isHidden && styles.avatarHidden)}
                                    style={{ borderColor: getAccountColor(account.id, accounts) }}
                                >
                                    <AccountAvatar account={account} size={22} />
                                </span>
                            </Badge>
                        </IconButton>
                    </Tooltip>
                );
            })}
        </span>
    );
}
