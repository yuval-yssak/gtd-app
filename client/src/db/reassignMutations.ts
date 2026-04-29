import type { IDBPDatabase } from 'idb';
// Import via the '#api/syncApi' alias so tests automatically pick up syncApi.mock.ts.
import { reassignEntityOnServer } from '#api/syncApi';
import type { ReassignParams, ReassignResponse } from '../api/syncApi';
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
