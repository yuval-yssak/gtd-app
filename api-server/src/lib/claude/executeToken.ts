import { createHmac, timingSafeEqual } from 'node:crypto';
import { stableStringify } from '../stableStringify.js';
import type { ProposableItemField } from './proposalSchema.js';

/**
 * Short-lived, server-signed grant for exactly one approved write. It is SIGNED, not encrypted —
 * the contents are non-secret; we only need tamper-evidence and a bound target. The model never
 * sees or produces a token: the route mints it AFTER the loop, from the model's structured proposal.
 *
 * The token's authority is the `target`, not the payload values. Editing the payload (e.g. tweaking
 * the proposed title) reuses the same token; changing the target (a different item or a field outside
 * the authorized set) must re-issue — see verify + the apply handler (§8.1).
 */

const TOKEN_VERSION = 1;
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

// A calendar change is expressed as an `itemPatch` that sets status:calendar + timeStart/timeEnd, so
// `itemPatch` is the only kind. Kept as a single-member type (not inlined) so a future server-side
// side-effect kind can be added back here, at the schema enum, and in the apply switch together.
export type ExecuteTokenKind = 'itemPatch';

export interface ExecuteTokenTarget {
    /** Item the write applies to. */
    itemId: string;
    /** Fields the apply handler is authorized to write. A submitted patch must be a subset of these. */
    fields: ProposableItemField[];
}

export interface ExecuteTokenPayload {
    v: number;
    kind: ExecuteTokenKind;
    /** Item owner (item.user) — the account whose data is written. Never the caller's session id. */
    user: string;
    target: ExecuteTokenTarget;
    /** sha256-free integrity anchor for the payload values at issue time (audit/diff, not a hard gate). */
    payloadHash: string;
    iat: number;
    exp: number;
}

let devFallbackWarned = false;

function getSigningKey(): Buffer {
    const key = process.env.EXECUTE_TOKEN_SIGNING_KEY ?? '';
    // Measure raw bytes, not UTF-8 code points: a key of 32 multi-byte chars is fine, but `.length`
    // would also pass a string that's shorter in bytes for some encodings. 32 bytes = the sha256
    // block/key floor we want for the HMAC. In production a missing/weak key is a hard error so we
    // never sign with the public in-repo fallback; outside production we fall back for local dev.
    if (Buffer.byteLength(key, 'utf8') >= 32) {
        return Buffer.from(key, 'utf8');
    }
    if (process.env.NODE_ENV === 'production') {
        throw new Error('EXECUTE_TOKEN_SIGNING_KEY must be set (>= 32 bytes) in production');
    }
    // Never silent: warn once so a developer isn't surprised that tokens are signed with a public,
    // in-repo key (anyone can forge them) when they forgot to set EXECUTE_TOKEN_SIGNING_KEY locally.
    if (!devFallbackWarned) {
        devFallbackWarned = true;
        console.warn('[claude-assist] EXECUTE_TOKEN_SIGNING_KEY unset/weak — using the public dev fallback key. Set a 32+ byte key.');
    }
    return Buffer.from('dev-execute-token-signing-key-placeholder', 'utf8');
}

function sign(payloadJson: string): string {
    return createHmac('sha256', getSigningKey()).update(payloadJson).digest('base64url');
}

/** Mints a signed token for the given grant. `now` is injectable for tests. */
export function signExecuteToken(
    grant: { kind: ExecuteTokenKind; user: string; target: ExecuteTokenTarget; payloadHash: string },
    now: number = Date.now(),
): string {
    const payload: ExecuteTokenPayload = {
        v: TOKEN_VERSION,
        kind: grant.kind,
        user: grant.user,
        target: grant.target,
        payloadHash: grant.payloadHash,
        iat: now,
        exp: now + DEFAULT_TTL_MS,
    };
    const payloadJson = stableStringify(payload);
    const encodedPayload = Buffer.from(payloadJson, 'utf8').toString('base64url');
    return `${encodedPayload}.${sign(payloadJson)}`;
}

export type VerifyResult = { ok: true; payload: ExecuteTokenPayload } | { ok: false; code: 'invalid_execute_token' | 'execute_token_expired' };

/** Verifies signature + expiry. `now` is injectable for tests. */
export function verifyExecuteToken(token: string, now: number = Date.now()): VerifyResult {
    const parts = token.split('.');
    if (parts.length !== 2) {
        return { ok: false, code: 'invalid_execute_token' };
    }
    const [encodedPayload, providedSig] = parts as [string, string];
    let payloadJson: string;
    try {
        payloadJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    } catch {
        return { ok: false, code: 'invalid_execute_token' };
    }
    const expectedSig = sign(payloadJson);
    const a = Buffer.from(providedSig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return { ok: false, code: 'invalid_execute_token' };
    }
    let payload: ExecuteTokenPayload;
    try {
        payload = JSON.parse(payloadJson) as ExecuteTokenPayload;
    } catch {
        return { ok: false, code: 'invalid_execute_token' };
    }
    if (payload.v !== TOKEN_VERSION) {
        return { ok: false, code: 'invalid_execute_token' };
    }
    if (payload.exp <= now) {
        return { ok: false, code: 'execute_token_expired' };
    }
    return { ok: true, payload };
}

/** Stable hash of a payload object, for the token's `payloadHash` integrity anchor. */
export function hashPayload(payload: unknown): string {
    return createHmac('sha256', getSigningKey()).update(stableStringify(payload)).digest('base64url');
}
