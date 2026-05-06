/**
 * Personal API token issuance + bearer-header resolution.
 *
 * REVOCATION-PROPAGATION GUARDRAIL (issue #19 step 11): do NOT add an in-process token cache
 * (e.g. `Map<tokenId, ApiTokenInterface>`) here or in `bearerMiddleware.ts` without also wiring
 * an invalidation channel (SSE/Redis pub-sub). Revocation today goes straight to Mongo and the
 * very next request that authenticates re-reads the row, so a `DELETE /account/tokens/:id`
 * propagates within milliseconds. A cache without invalidation breaks that contract — revoked
 * tokens would keep authenticating until the cache entry expired, and on multi-instance deploys
 * the divergence is unbounded. The 1ms saved per request is not worth the consistency story.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import apiTokensDAO from '../dataAccess/apiTokensDAO.js';
import { type ApiTokenInterface, type ApiTokenScope, DEFAULT_API_TOKEN_SCOPES } from '../types/entities.js';

const TOKEN_PREFIX = 'gtd_';
// 32 random bytes → 43-char base64url. With the prefix this yields ~47 chars total, plenty of entropy
// to make brute force impractical and short enough to paste into MCP env files.
const TOKEN_RANDOM_BYTES = 32;

/** Hash a plaintext token for storage / lookup. Sha-256 hex. Pure — no side effects. */
export function hashToken(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex');
}

/** Generates a fresh token. Returns the plaintext — caller is responsible for showing it once and discarding. */
export function generateTokenPlaintext(): string {
    return `${TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')}`;
}

interface CreateTokenResult {
    /** Plaintext shown to the user exactly once. Never re-derivable from storage. */
    plaintext: string;
    record: ApiTokenInterface;
}

/** Issues a new token for `userId` with the given label and scopes. Defaults to capture+read when scopes are omitted. */
export async function issueApiToken(userId: string, label: string, scopes: ApiTokenScope[] = DEFAULT_API_TOKEN_SCOPES): Promise<CreateTokenResult> {
    const plaintext = generateTokenPlaintext();
    const record: ApiTokenInterface = {
        _id: randomUUID(),
        user: userId,
        tokenHash: hashToken(plaintext),
        label,
        createdTs: dayjs().toISOString(),
        scopes,
    };
    await apiTokensDAO.insertOne(record);
    return { plaintext, record };
}

/**
 * Resolves a `Bearer gtd_…` header to an active token row, or returns null when the header is
 * missing/malformed/unknown/revoked. Constant-time matters less here than for password checks
 * because the hashed lookup itself is the auth gate, but we still avoid early returns that leak
 * structure beyond "valid vs invalid".
 */
export async function resolveBearerToken(authorizationHeader: string | undefined): Promise<ApiTokenInterface | null> {
    if (!authorizationHeader) {
        return null;
    }
    const [scheme, value] = authorizationHeader.split(' ');
    if (scheme !== 'Bearer' || !value || !value.startsWith(TOKEN_PREFIX)) {
        return null;
    }
    return apiTokensDAO.findActiveByHash(hashToken(value));
}
