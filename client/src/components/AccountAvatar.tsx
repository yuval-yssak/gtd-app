import { Avatar } from '@base-ui/react/avatar';
import type { StoredAccount } from '../types/MyDB';
import styles from './AccountAvatar.module.css';

/** Round account avatar with an initial-letter fallback (shown too when the image fails to load). Shared by AccountSwitcher and AccountVisibilityToggles. */
export function AccountAvatar({ account, size }: { account: StoredAccount | undefined; size: number }) {
    // The diameter is a per-call number; the initial scales with it (MUI's 1.25rem-on-40px ratio).
    const sizeStyle = { '--avatar-size': `${size / 16}rem` };
    return (
        <Avatar.Root className={styles.avatar} style={sizeStyle}>
            {account?.image && <Avatar.Image src={account.image} alt={account.name ?? 'Account'} className={styles.image} />}
            <Avatar.Fallback className={styles.fallback}>{account?.name?.[0]?.toUpperCase() ?? '?'}</Avatar.Fallback>
        </Avatar.Root>
    );
}
