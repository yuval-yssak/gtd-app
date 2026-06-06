import { createHmac, timingSafeEqual } from 'node:crypto';
import { stableStringify } from '../stableStringify.js';
import type { ProposableItemField } from './proposalSchema.js';

/**
 * Short-lived, server-signed grant for exactly one approved write. It is SIGNED, not encrypted —
 * the contents are non-secret; we only need tamper-evidence and a bound target. The model never
 * sees or produces a token: the route mints it AFTER the loop, from the model's structured proposal.
 *
 * The token's authority is the `target`, not the payload values. Editing the payload (e.g. tweaking
 * the proposed title) reuses the same token; changing the target (a different item, a field outside
 * the authorized set, a different kind) must re-issue — see verify + the apply handler (§8.1).
 */

const TOKEN_VERSION = 1;
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type ExecuteTokenKind = 'itemPatch' | 'calendarSideEffect';

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

function getSigningKey(): Buffer {
    const key = process.env.EXECUTE_TOKEN_SIGNING_KEY ?? '';
    // Require a reasonably strong key. In production a missing/weak key is a hard error so we never
    // sign tokens with the public in-repo fallback; outside production we fall back for local dev.
    if (key.length >= 32) {
        return Buffer.from(key, 'utf8');
    }
    if (process.env.NODE_ENV === 'production') {
        throw new Error('EXECUTE_TOKEN_SIGNING_KEY must be set (>= 32 chars) in production');
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
