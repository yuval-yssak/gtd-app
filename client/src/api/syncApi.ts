import { API_SERVER } from '../constants/globals';
import type { EnergyLevel, EntityType } from '../types/MyDB';

/** Mirrors the server's TargetCalendar shape — required for reassigning calendar-linked items. */
export interface TargetCalendar {
    integrationId: string;
    syncConfigId: string;
}

/**
 * Whitelisted item edits that ride along on a reassign — lets the dialog edit + move atomically.
 * Mirrors the server's ReassignItemEditPatch. Empty string ('') and empty array ([]) are the
 * "clear this field" sentinel; omitted keys leave the existing value untouched.
 */
export interface ReassignItemEditPatch {
    title?: string;
    notes?: string;
    timeStart?: string;
    timeEnd?: string;
    workContextIds?: string[];
    peopleIds?: string[];
    /** Energy level — empty string '' clears a previously-set value. */
    energy?: EnergyLevel | '';
    /** Time estimate in minutes — empty string '' clears a previously-set value. */
    time?: number | '';
    urgent?: boolean;
    focus?: boolean;
    expectedBy?: string;
    ignoreBefore?: string;
    waitingForPersonId?: string;
}

/** Whitelisted routine edits that ride along on a reassign. Mirrors server's ReassignRoutineEditPatch. */
export interface ReassignRoutineEditPatch {
    title?: string;
    rrule?: string;
    startDate?: string;
    routineType?: 'nextAction' | 'calendar';
    template?: Record<string, unknown>;
    calendarItemTemplate?: { timeOfDay: string; duration: number };
    active?: boolean;
}

export interface ReassignParams {
    entityType: EntityType;
    entityId: string;
    fromUserId: string;
    toUserId: string;
    /** Required when reassigning a calendar-linked item; ignored for everything else. */
    targetCalendar?: TargetCalendar;
    /** Item field edits applied atomically with the move. Ignored for non-item entityTypes. */
    editPatch?: ReassignItemEditPatch;
    /** Routine field edits applied atomically with the move. Ignored for non-routine entityTypes. */
    editRoutinePatch?: ReassignRoutineEditPatch;
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
