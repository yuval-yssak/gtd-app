import { API_SERVER } from '../constants/globals';
import type { EntityType } from '../types/MyDB';

/** Mirrors the server's TargetCalendar shape — required for reassigning calendar-linked items. */
export interface TargetCalendar {
    integrationId: string;
    syncConfigId: string;
}

export interface ReassignParams {
    entityType: EntityType;
    entityId: string;
    fromUserId: string;
    toUserId: string;
    /** Required when reassigning a calendar-linked item; ignored for everything else. */
    targetCalendar?: TargetCalendar;
}

/** Discriminated response — `ok: true` plus optional cross-user reference hints, or `ok: false` with a status code. */
export type ReassignResponse =
    | { ok: true; crossUserReferences?: { peopleIds?: string[]; workContextIds?: string[] } }
    | { ok: false; status: number; error: string };

/**
 * Calls `POST /sync/reassign`. Errors are returned as discriminated `{ ok: false }` so the
 * caller can present a toast without a try/catch. Network failures throw; HTTP error statuses
 * (400/403/404/502) are surfaced in the discriminated branch.
 */
export async function reassignEntityOnServer(params: ReassignParams): Promise<ReassignResponse> {
    const res = await fetch(`${API_SERVER}/sync/reassign`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });
    if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, status: res.status, error: body.error ?? `POST /sync/reassign ${res.status}` };
    }
    return (await res.json()) as { ok: true; crossUserReferences?: { peopleIds?: string[]; workContextIds?: string[] } };
}
