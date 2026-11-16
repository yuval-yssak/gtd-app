import type { IDBPDatabase } from 'idb';
import { useSyncExternalStore } from 'react';
import { Text } from '../designSystem';
import { useOnline } from '../hooks/useOnline';
import { isAnyAccountVerified, subscribeToSyncFreshness } from '../lib/syncFreshness';
import type { MyDB } from '../types/MyDB';
import { AccountReauthBanner } from './AccountReauthBanner';
import styles from './StatusBar.module.css';
import { SyncIssuesPanel } from './SyncIssuesPanel';

export function StatusBar({ db }: { db: IDBPDatabase<MyDB> }) {
    const online = useOnline();
    // On a hanging network the browser still says online; this says whether the server has answered.
    const isServerReached = useSyncExternalStore(subscribeToSyncFreshness, isAnyAccountVerified);

    return (
        <div className={styles.root}>
            <span className={styles.dot} data-online={online || undefined} aria-hidden="true" />
            <Text variant="caption" tone="secondary">
                {online ? 'Online' : 'Offline'}
            </Text>
            {online && !isServerReached && (
                <Text variant="caption" tone="secondary" data-testid="statusBarAwaitingServer" className={styles.awaitingServer}>
                    · waiting for server
                </Text>
            )}
            {/* Both mount unconditionally — each self-suppresses (returns null) when it has nothing to
                show, so an empty state has zero visual footprint. */}
            <SyncIssuesPanel />
            <AccountReauthBanner db={db} />
        </div>
    );
}
