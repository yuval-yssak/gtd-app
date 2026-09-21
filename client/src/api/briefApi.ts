import { API_SERVER } from '../constants/globals';
import { isBrowserOffline } from '../lib/onlineStatus';
import type { BriefOrigin, StoredItemBrief } from '../types/MyDB';

/**
 * HTTP wrapper for the on-demand brief generator (`POST /v1/items/:id/brief/generate`). Mirrors
 * `assistApi.ts`: a first-party `credentials: 'include'` fetch (the route is dual-auth and accepts
 * the Better Auth session cookie — callers pin it to the item's owner via `withOwnerSession`) plus
 * a typed error class carrying the server's `code` so the button can branch on pinned / rate-limit
 * / unconfigured.
 */

/**
 * The brief row as the server sends it: the wire field is `user`, remapped to `userId` when the
 * row is applied locally — the same remap inbound sync performs.
 */
export type ServerItemBriefSnapshot = Omit<StoredItemBrief, 'userId'> & { user: string };

/**
 * - `written`         — a fresh model brief was stored; `brief` carries it.
 * - `skipped`         — the notes were too short; `brief` is the stored `text: null` row.
 * - `discarded_stale` — the item's title/notes changed while the model ran; nothing was written.
 */
export type GenerateBriefResult =
    | { outcome: 'written'; brief: ServerItemBriefSnapshot }
    | { outcome: 'skipped'; brief: ServerItemBriefSnapshot }
    | { outcome: 'discarded_stale'; brief: null };

export type GenerateBriefOutcome = GenerateBriefResult['outcome'];

/** The server error `code`s the button branches on. `undefined` covers a network failure, a non-JSON body, or an unknown code. */
const BRIEF_ERROR_CODES = [
    'brief_pinned',
    'not_found',
    'forbidden_scope',
    'rate_limited',
    'agent_unavailable',
    'brief_generation_failed',
    'unauthorized',
] as const;
export type BriefErrorCode = (typeof BRIEF_ERROR_CODES)[number];

function toBriefErrorCode(value: unknown): BriefErrorCode | undefined {
    return BRIEF_ERROR_CODES.find((code) => code === value);
}

const RETRY_AFTER_HEADER = 'Retry-After';
/**
 * Client-side deadline. The server has its own agent timeout, but that only helps when a response
 * comes back — a black-holed connection would otherwise leave the sparkle button disabled forever.
 */
const GENERATE_BRIEF_TIMEOUT_MS = 90_000;

/** What the server said about a failed generation: HTTP status, its `code`, and (429) `Retry-After` seconds. */
export interface BriefApiFailure {
    status: number;
    code?: BriefErrorCode | undefined;
    retryAfterSeconds?: number | undefined;
}

/** Surfaces the server's `code`, HTTP status and (for 429) the `Retry-After` seconds. */
export class BriefApiError extends Error {
    readonly status: number;
    readonly code: BriefErrorCode | undefined;
    readonly retryAfterSeconds: number | undefined;
    constructor(message: string, failure: BriefApiFailure) {
        super(message);
        this.name = 'BriefApiError';
        this.status = failure.status;
        this.code = failure.code;
        this.retryAfterSeconds = failure.retryAfterSeconds;
    }
}

/**
 * Reads a wire body as an object with only the named keys, each `unknown`. Safe cast: every
 * property stays `unknown` and gets narrowed by the caller, so nothing is trusted from the wire.
 */
function asLooseObject<K extends string>(value: unknown): { [P in K]?: unknown } | undefined {
    return typeof value === 'object' && value !== null ? (value as { [P in K]?: unknown }) : undefined;
}

function readErrorBody(body: unknown): { message: string | undefined; code: BriefErrorCode | undefined } {
    const errorBody = asLooseObject<'error' | 'code'>(body);
    return {
        message: typeof errorBody?.error === 'string' ? errorBody.error : undefined,
        code: toBriefErrorCode(errorBody?.code),
    };
}

/** `Retry-After` is a whole number of seconds on this API; anything unparsable reads as unknown. */
function readRetryAfterSeconds(response: Response): number | undefined {
    const raw = response.headers.get(RETRY_AFTER_HEADER);
    const seconds = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function toBriefApiError(response: Response): Promise<BriefApiError> {
    const { message, code } = readErrorBody(await response.json().catch(() => undefined));
    return new BriefApiError(message ?? `brief API error ${response.status}`, {
        status: response.status,
        code,
        retryAfterSeconds: readRetryAfterSeconds(response),
    });
}

const BRIEF_ORIGINS: readonly BriefOrigin[] = ['user', 'agent', 'model', 'skipped'];

/**
 * The fields the local store keys decisions on: identity + LWW anchor, and `origin`, which drives
 * pinned-ness and the derived brief state (this row bypasses the op log, so it is checked here).
 */
function isBriefSnapshot(value: unknown): value is ServerItemBriefSnapshot {
    const row = asLooseObject<'_id' | 'user' | 'updatedTs' | 'origin'>(value);
    if (row === undefined) {
        return false;
    }
    return (
        typeof row._id === 'string' &&
        typeof row.user === 'string' &&
        typeof row.updatedTs === 'string' &&
        BRIEF_ORIGINS.some((origin) => origin === row.origin)
    );
}

/**
 * Narrows the 200 body to the discriminated result. A body that contradicts the contract (e.g.
 * `written` without a row) is an error, not a silently-empty result.
 */
function parseGenerateBriefBody(body: unknown): GenerateBriefResult {
    const { outcome, brief } = asLooseObject<'outcome' | 'brief'>(body) ?? {};
    if (outcome === 'discarded_stale') {
        return { outcome, brief: null };
    }
    if ((outcome === 'written' || outcome === 'skipped') && isBriefSnapshot(brief)) {
        return { outcome, brief };
    }
    throw new BriefApiError(`unexpected brief generation response (outcome=${String(outcome)})`, { status: 200 });
}

/** Asks the server to generate (or, with `force`, replace a pinned) brief for `itemId`. */
export async function generateBrief(itemId: string, { force = false }: { force?: boolean } = {}): Promise<GenerateBriefResult> {
    // credentials: 'include' — the Better Auth session cookie travels cross-origin (client ≠ API domain).
    const response = await fetch(`${API_SERVER}/v1/items/${encodeURIComponent(itemId)}/brief/generate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
        signal: AbortSignal.timeout(GENERATE_BRIEF_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw await toBriefApiError(response);
    }
    return parseGenerateBriefBody(await response.json());
}

// ── Review-start sweep (`POST /maintenance/briefs/sweep-mine`) ───────────────

/**
 * What the review-start sweep did, as the caller needs to know it:
 * - `started`   — the server queued `started` background generations (`cooldown: false`).
 * - `cooldown`  — the caller already swept within the server's window; expected, not an error.
 * - `skipped`   — the client never asked (offline).
 * - `failed`    — the request or its body did not come back usable. Advisory only: nothing to show.
 *
 * Deliberately a RESULT, not an exception: the sweep is a best-effort freshness nudge behind the
 * review, so every failure mode has to be expressible without a `try` at the call site.
 */
export type ReviewSweepResult =
    | { outcome: 'started'; started: number; skippedWritten: number }
    | { outcome: 'cooldown' }
    | { outcome: 'skipped'; reason: 'offline' }
    | { outcome: 'failed'; status: number | undefined };

/**
 * The server returns once the cheap skip rows are written (the model generations continue in the
 * background), so this only has to cover a slow item-set walk. Kept BELOW `withSessionGate`'s
 * 10 s escape hatch (`db/syncHelpers.ts`): a request that outlived the gate would trip its
 * "task exceeded" release while still holding a pivoted session cookie — exactly the drift the
 * gate exists to prevent.
 */
const REVIEW_SWEEP_TIMEOUT_MS = 8_000;

/** Narrows the 200 body; a body that does not match the contract reads as `failed`, never as `started: NaN`. */
function parseReviewSweepBody(body: unknown): ReviewSweepResult {
    const row = asLooseObject<'started' | 'skippedWritten' | 'cooldown'>(body);
    if (row?.cooldown === true) {
        return { outcome: 'cooldown' };
    }
    // `cooldown` is the server's discriminant, so the success branch keys on it rather than on
    // field presence — a body missing it is not the contract, whatever else it carries.
    if (row?.cooldown === false && typeof row.started === 'number' && typeof row.skippedWritten === 'number') {
        return { outcome: 'started', started: row.started, skippedWritten: row.skippedWritten };
    }
    return { outcome: 'failed', status: 200 };
}

/**
 * Asks the server to refresh the caller's briefs whose title + notes checksum moved (open decision
 * 5 in `docs/plans/item-brief.md`). Fire-and-forget from the Weekly Review: the generated briefs
 * arrive later as ordinary `itemBrief` sync ops, so NOTHING in this response is applied locally —
 * it is only logged. Never rejects; every failure is an `outcome` the caller can ignore.
 *
 * The offline check here is the LAST line of defence, not the real gate: the wizard's caller pins
 * the session first (`withOwnerSession` makes its own network call), so it has to decide offline
 * before ever reaching this function — see `reviewBriefSweep.ts`'s `isOnline` port. This keeps a
 * direct caller from firing a pointless request.
 */
export async function startReviewBriefSweep(): Promise<ReviewSweepResult> {
    if (isBrowserOffline()) {
        return { outcome: 'skipped', reason: 'offline' };
    }
    try {
        // credentials: 'include' — session-cookie authed, same as the other /maintenance routes.
        const response = await fetch(`${API_SERVER}/maintenance/briefs/sweep-mine`, {
            method: 'POST',
            credentials: 'include',
            signal: AbortSignal.timeout(REVIEW_SWEEP_TIMEOUT_MS),
        });
        if (!response.ok) {
            return { outcome: 'failed', status: response.status };
        }
        // `.catch` here, not on the whole call: an unreadable 200 body is a contract failure of a
        // successful request, so it keeps the 200 rather than reading as a network error.
        return parseReviewSweepBody(await response.json().catch(() => undefined));
    } catch {
        // Network error or the deadline abort: advisory call, so it dies here.
        return { outcome: 'failed', status: undefined };
    }
}
