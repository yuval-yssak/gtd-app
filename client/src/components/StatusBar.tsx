import CircleIcon from '@mui/icons-material/Circle';
import Typography from '@mui/material/Typography';
import type { IDBPDatabase } from 'idb';
import { useOnline } from '../hooks/useOnline';
import type { MyDB } from '../types/MyDB';
import { AccountReauthBanner } from './AccountReauthBanner';
import styles from './StatusBar.module.css';
import { SyncIssuesPanel } from './SyncIssuesPanel';

export function StatusBar({ db }: { db: IDBPDatabase<MyDB> }) {
    const online = useOnline();

    return (
        <div className={styles.root}>
            <CircleIcon className={online ? styles.dotOnline : styles.dotOffline} />
            <Typography
                variant="caption"
                sx={{
                    color: 'text.secondary',
                }}
            >
                {online ? 'Online' : 'Offline'}
            </Typography>
            {/* Both mount unconditionally — each self-suppresses (returns null) when it has nothing to
                show, so an empty state has zero visual footprint. */}
            <SyncIssuesPanel />
            <AccountReauthBanner db={db} />
        </div>
    );
}
