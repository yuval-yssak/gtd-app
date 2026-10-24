import { useAppData } from '../contexts/AppDataProvider';
import { Chip } from '../designSystem';
import { getAccountColor } from '../lib/accountColors';
import styles from './AccountChip.module.css';

interface AccountChipProps {
    /** Better Auth user ID — usually the entity's `userId` (e.g. item.userId). */
    userId: string;
}

/**
 * Renders a small coloured chip with the account email next to an entity. Hidden when there
 * is only one logged-in account on the device — single-account devices have no ambiguity to
 * surface, so the chip would be visual noise. The colour comes from accountColors.ts and is
 * deterministic per (userId, sorted-account-list) so the same account always reads as the
 * same colour across renders, sessions, and reloads.
 */
export function AccountChip({ userId }: AccountChipProps) {
    const { loggedInAccounts } = useAppData();
    if (loggedInAccounts.length <= 1) {
        return null;
    }
    const account = loggedInAccounts.find((a) => a.id === userId);
    // Prefer the email so the chip is unambiguous; if the account is missing fall back to a
    // generic label rather than rendering nothing — a missing chip would silently hide that
    // an entity belongs to an account no longer in the device's session list.
    const label = account?.email ?? 'unknown account';
    // The fill is per account (a runtime palette pick), so it is handed to the module as a custom property.
    const accountStyle = { '--account-color': getAccountColor(userId, loggedInAccounts) };
    return <Chip className={styles.chip} style={accountStyle} label={label} data-testid="accountChip" />;
}
