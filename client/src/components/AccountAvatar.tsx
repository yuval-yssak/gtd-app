import Avatar from '@mui/material/Avatar';
import type { StoredAccount } from '../types/MyDB';

/** Round account avatar with an initial-letter fallback. Shared by AccountSwitcher and AccountVisibilityToggles. */
export function AccountAvatar({ account, size }: { account: StoredAccount | undefined; size: number }) {
    // fontSize: MUI Avatar default is 1.25rem on 40px = ~0.375 ratio; scale it with size
    // Inline style used because width/height/fontSize are dynamic — computed from the size prop at runtime
    return (
        <Avatar src={account?.image ?? undefined} alt={account?.name ?? 'Account'} style={{ width: size, height: size, fontSize: size * 0.375 }}>
            {!account?.image && (account?.name?.[0]?.toUpperCase() ?? '?')}
        </Avatar>
    );
}
