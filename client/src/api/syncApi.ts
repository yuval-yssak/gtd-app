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
    /** All-day flag — true/false flips between date-only and ISO-datetime semantics on timeStart/timeEnd. */
    allDay?: boolean;
}

/** Whitelisted routine edits that ride along on a reassign. Mirrors server's ReassignRoutineEditPatch. */
export interface ReassignRoutineEditPatch {
    title?: string;
    rrule?: string;
    startDate?: string;
    routineType?: 'nextAction' | 'calendar';
    template?: Record<string, unknown>;
    /**
     * Calendar item template. All-day routines carry only `{ allDay: true }`; timed routines carry
     * `{ timeOfDay, duration }`. Shape mirrors RoutineInterface.calendarItemTemplate on the server.
     */
    calendarItemTemplate?: { allDay: true } | { timeOfDay: string; duration: number };
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

// ─── Sync Issues panel API ───────────────────────────────────────────────────

/**
 * Mirror of the server's `OpFailureReason` enum. Kept inline (not imported from server types)
 * because the client cannot reach into api-server packages. Adding a new server-side reason
 * requires updating BOTH this union AND the failure-label map in `SyncIssuesPanel`.
 */
export type SyncIssueFailureReason = 'transient_exhausted' | 'scope_missing' | 'calendar_missing' | 'edit_conflict' | 'terminal';

/** One row in the SyncIssuesPanel — projection of a persisted op with `syncFailed: true`. */
export interface SyncIssue {
    _id: string;
    ts: string;
    opType: string;
    entityType: string;
    entityId: string;
    failureReason: SyncIssueFailureReason;
    failureDetail?: string;
    /** False for `terminal` reasons; true for retryable buckets surfaced as Retry button. */
    retryable: boolean;
}

/** Discriminated result of a Retry click — `false` keeps the row in place; `true` clears it. */
export type RetrySyncIssueResult = { ok: true } | { ok: false; failureReason?: SyncIssueFailureReason };

/** GET /sync/issues — drives the panel's render. Throws on non-2xx so the boundary can show a toast. */
export async function fetchSyncIssues(): Promise<SyncIssue[]> {
    const res = await fetch(`${API_SERVER}/sync/issues`, { credentials: 'include' });
    if (!res.ok) {
        throw new Error(`GET /sync/issues ${res.status}`);
    }
    const body = (await res.json()) as { issues: SyncIssue[] };
    return body.issues;
}

/** POST /sync/issues/:opId/retry — re-runs the GCal-side effect server-side. */
export async function retrySyncIssue(opId: string): Promise<RetrySyncIssueResult> {
    const res = await fetch(`${API_SERVER}/sync/issues/${opId}/retry`, { method: 'POST', credentials: 'include' });
    if (!res.ok) {
        return { ok: false };
    }
    return (await res.json()) as RetrySyncIssueResult;
}

/** POST /sync/issues/:opId/dismiss — removes the op row server-side. */
export async function dismissSyncIssue(opId: string): Promise<{ ok: boolean }> {
    const res = await fetch(`${API_SERVER}/sync/issues/${opId}/dismiss`, { method: 'POST', credentials: 'include' });
    return { ok: res.ok };
}
