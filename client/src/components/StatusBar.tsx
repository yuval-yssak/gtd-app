import type { IDBPDatabase } from 'idb';
import { Text } from '../designSystem';
import { useOnline } from '../hooks/useOnline';
import type { MyDB } from '../types/MyDB';
import { AccountReauthBanner } from './AccountReauthBanner';
import styles from './StatusBar.module.css';
import { SyncIssuesPanel } from './SyncIssuesPanel';

export function StatusBar({ db }: { db: IDBPDatabase<MyDB> }) {
    const online = useOnline();

    return (
        <div className={styles.root}>
            <span className={styles.dot} data-online={online || undefined} aria-hidden="true" />
            <Text variant="caption" tone="secondary">
                {online ? 'Online' : 'Offline'}
            </Text>
            {/* Both mount unconditionally — each self-suppresses (returns null) when it has nothing to
                show, so an empty state has zero visual footprint. */}
            <SyncIssuesPanel />
            <AccountReauthBanner db={db} />
        </div>
    );
}
