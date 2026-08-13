import type { IDBPDatabase } from 'idb';
// Import via the '#api/syncApi' alias so tests automatically pick up syncApi.mock.ts.
import { reassignEntityOnServer } from '#api/syncApi';
import type { ReassignParams, ReassignResponse } from '../api/syncApi';
import { isBrowserOffline } from '../lib/onlineStatus';
import type { MyDB } from '../types/MyDB';
import { syncAllLoggedInUsers } from './multiUserSync';

/**
 * Drives a cross-account entity move. The server handles the atomic delete+create + GCal moves;
 * the client just relays the request and pulls the resulting ops on both source and target SSE
 * channels via `syncAllLoggedInUsers`. We don't pre-write IDB because the new owner's user id
 * isn't always known until the server confirms the move (errors mid-flight would leave IDB in
 * a bad state).
 */
export async function reassignEntity(db: IDBPDatabase<MyDB>, params: ReassignParams): Promise<ReassignResponse> {
    const result = await reassignEntityOnServer(params);
    if (!result.ok) {
        return result;
    }
    // Pull on both fromUser + toUser channels so source loses the entity and target gains it
    // immediately. Without this, the user would see stale IDB data until the next SSE event.
    await syncAllLoggedInUsers(db);
    return result;
}

export function offlineReassignMessage(label: string) {
    return `You're offline — "${label}" wasn't moved. Try again when connected.`;
}

function moveFailureMessage(label: string, reason: string) {
    return `Couldn't move "${label}" — ${reason}`;
}

export type ReassignAttempt = { ok: true } | { ok: false; message: string };

/**
 * `reassignEntity` with user-facing outcome mapping. Reassign is the one mutation that can't join
 * the offline sync queue (the server orchestrates an atomic cross-account delete+create), so
 * offline attempts, server rejections, and network throws all become a message the caller can
 * surface — never a silent unhandled rejection.
 */
export async function attemptReassign(db: IDBPDatabase<MyDB>, params: ReassignParams, label: string): Promise<ReassignAttempt> {
    if (isBrowserOffline()) {
        return { ok: false, message: offlineReassignMessage(label) };
    }
    try {
        const result = await reassignEntity(db, params);
        if (!result.ok) {
            console.warn('[reassign] server rejected:', result.status, result.error);
            return { ok: false, message: moveFailureMessage(label, result.error) };
        }
        return { ok: true };
    } catch (err) {
        console.error('[reassign] request failed:', err);
        return { ok: false, message: moveFailureMessage(label, 'check your connection and try again.') };
    }
}
