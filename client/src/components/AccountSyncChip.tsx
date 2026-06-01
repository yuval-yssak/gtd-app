import { useAppData } from '../contexts/AppDataProvider';
import { SyncingChip } from './SyncingChip';

/**
 * "Syncing account…" chip for list-page headers. Renders only while a fresh-launch bootstrap is in
 * flight (`isInitialSyncing`). Unlike the empty-state skeleton, this surfaces the indicator even
 * when the list already has items — the case where a SECOND account is added: account A's items are
 * already on screen, so the empty-state branch never renders and the skeleton would never show.
 * The chip sits beside the title so account B's incoming items are signalled without reflowing the list.
 */
export function AccountSyncChip() {
    const { isInitialSyncing } = useAppData();
    if (!isInitialSyncing) {
        return null;
    }
    return <SyncingChip label="Syncing account…" />;
}
