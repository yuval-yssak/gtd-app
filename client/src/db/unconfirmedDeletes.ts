import dayjs from 'dayjs';
import type { SyncOperation } from '../types/MyDB';

/**
 * Deletes this context pushed whose own delete op the server has not echoed back through a pull
 * yet. Until it has, a pulled create/update for that entity is a stale re-delivery (the server
 * re-sends the last few seconds of ops on every pull) that was fetched before the delete landed —
 * applying it would resurrect the row, and this device ignores the SSE echo of its own delete,
 * so no later pull would remove it again.
 *
 * In memory only: after a reload the next pull re-delivers the delete anyway. A delete the server
 * never records (so never echoes) stops holding its entity back after the TTL, so a genuine
 * re-create is not blocked for the life of the tab.
 *
 * Known residual: the map is per context. A delete the Service Worker pushes (Background Sync) is
 * unknown to the tab, so a tab pull fetched before that push and applied after it can still
 * resurrect the row until the next pull re-delivers the delete. Rare — it needs the SW to flush
 * while a tab pull is in flight.
 */
const UNCONFIRMED_DELETE_TTL_MS = 2 * 60 * 1000;
const pushedAtByEntity = new Map<string, number>();

export const entityKey = (entityType: string, entityId: string) => `${entityType}:${entityId}`;

export function rememberPushedDeletes(pushed: SyncOperation[]): void {
    const now = dayjs().valueOf();
    for (const op of pushed.filter((candidate) => candidate.opType === 'delete')) {
        pushedAtByEntity.set(entityKey(op.entityType, op.entityId), now);
    }
}

/** The server's own delete op came back: from here on, pulled ops for the entity are newer than it. */
export function confirmDelete(key: string): void {
    pushedAtByEntity.delete(key);
}

export function isAwaitingDeleteEcho(key: string): boolean {
    const pushedAt = pushedAtByEntity.get(key);
    return pushedAt !== undefined && dayjs().valueOf() - pushedAt < UNCONFIRMED_DELETE_TTL_MS;
}

/** Test-only: forget every remembered delete so each case starts clean. */
export function __resetUnconfirmedDeletesForTests(): void {
    pushedAtByEntity.clear();
}
