import type { EntitySnapshot } from '../types/entities.js';

/**
 * Human-readable label for any synced entity: items/routines carry `title`, people/workContexts/
 * reviewInboxes carry `name`, and an item brief IS its one-line text. `undefined` (never `''`)
 * when there is no label — a skipped brief — so callers' "absent" checks stay honest.
 * Shared by web-push notification bodies and the SyncIssuesPanel rows.
 */
export function entityDisplayName(snapshot: EntitySnapshot): string | undefined {
    if ('title' in snapshot) {
        return snapshot.title;
    }
    if ('name' in snapshot) {
        return snapshot.name;
    }
    return snapshot.text ?? undefined;
}
