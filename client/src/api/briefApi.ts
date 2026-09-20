import { API_SERVER } from '../constants/globals';
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
