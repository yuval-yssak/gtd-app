import dayjs from 'dayjs';
import { Hono } from 'hono';
import { issueApiToken } from '../auth/apiTokens.js';
import { authenticateRequest } from '../auth/middleware.js';
import apiTokensDAO from '../dataAccess/apiTokensDAO.js';
import type { AuthVariables } from '../types/authTypes.js';
import { type ApiTokenInterface, type ApiTokenScope, DEFAULT_API_TOKEN_SCOPES, VALID_API_TOKEN_SCOPES } from '../types/entities.js';

/**
 * Per-user cap on active (not revoked) tokens, enforced on POST.
 *
 * DO NOT extract this into a shared constant. Dev (50, in `routes/devLogin.ts`) and prod (20 here)
 * have different risk profiles — see issue #19 item 12. Revoke + remint is a normal flow in prod;
 * the dev cap exists only as a safety net against accidental loops.
 */
export const PROD_TOKEN_CAP_PER_USER = 20;

interface PublicTokenView {
    id: string;
    label: string;
    createdTs: string;
    /** Capabilities granted to this token (capture / clarify / read). Defaults backfilled per row. */
    scopes: ApiTokenScope[];
    lastUsedTs?: string;
    revokedTs?: string;
}

/** Projects internal token shape to the public view. Strips `tokenHash` and `user` so neither leaks. */
function presentToken(token: ApiTokenInterface): PublicTokenView {
    const view: PublicTokenView = {
        id: token._id,
        label: token.label,
        createdTs: token.createdTs,
        scopes: token.scopes ?? DEFAULT_API_TOKEN_SCOPES,
    };
    if (token.lastUsedTs !== undefined) view.lastUsedTs = token.lastUsedTs;
    if (token.revokedTs !== undefined) view.revokedTs = token.revokedTs;
    return view;
}

interface CreateBody {
    label?: unknown;
    scopes?: unknown;
}

type MintError =
    | { code: 'token_cap_reached'; status: 429; message: string }
    | { code: 'invalid_label'; status: 400; message: string }
    | { code: 'invalid_scopes'; status: 400; message: string };

function parseLabel(raw: CreateBody): { ok: true; label: string } | { ok: false; error: MintError } {
    if (raw.label === undefined || raw.label === null || (typeof raw.label === 'string' && raw.label.trim() === '')) {
        // Match the dev endpoint's behaviour: empty label gets the placeholder so the row is still useful.
        return { ok: true, label: 'unlabeled' };
    }
    if (typeof raw.label !== 'string') {
        return { ok: false, error: { code: 'invalid_label', status: 400, message: 'label must be a string when provided' } };
    }
    return { ok: true, label: raw.label.trim() };
}

function parseScopes(raw: CreateBody): { ok: true; scopes: ApiTokenScope[] } | { ok: false; error: MintError } {
    if (raw.scopes === undefined) {
        return { ok: true, scopes: DEFAULT_API_TOKEN_SCOPES };
    }
    if (!Array.isArray(raw.scopes) || raw.scopes.length === 0) {
        return { ok: false, error: { code: 'invalid_scopes', status: 400, message: 'scopes must be a non-empty array of strings' } };
    }
    const seen = new Set<ApiTokenScope>();
    for (const s of raw.scopes) {
        if (typeof s !== 'string' || !VALID_API_TOKEN_SCOPES.has(s as ApiTokenScope)) {
            return {
                ok: false,
                error: {
                    code: 'invalid_scopes',
                    status: 400,
                    message: `unknown scope ${JSON.stringify(s)}; allowed: ${[...VALID_API_TOKEN_SCOPES].join(', ')}`,
                },
            };
        }
        seen.add(s as ApiTokenScope);
    }
    return { ok: true, scopes: [...seen] };
}

/** Mint orchestration extracted so the route handler stays at one level of abstraction. */
async function mintTokenForUser(
    userId: string,
    raw: CreateBody,
): Promise<{ ok: true; record: ApiTokenInterface; plaintext: string } | { ok: false; error: MintError }> {
    // count-then-insert is a TOCTOU on the cap: two concurrent POSTs from the same session can
    // both pass with active=cap-1, both insert, ending at cap+1. The cap is a UX guardrail rather
    // than a security boundary (settings UI is single-tab in normal use), so we accept the race
    // rather than wrap every mint in a transaction.
    const active = await apiTokensDAO.countActiveForUser(userId);
    if (active >= PROD_TOKEN_CAP_PER_USER) {
        return {
            ok: false,
            error: {
                code: 'token_cap_reached',
                status: 429,
                message: `Token cap reached (${PROD_TOKEN_CAP_PER_USER}). Revoke unused tokens before minting new ones.`,
            },
        };
    }
    const parsedLabel = parseLabel(raw);
    if (!parsedLabel.ok) {
        return { ok: false, error: parsedLabel.error };
    }
    const parsedScopes = parseScopes(raw);
    if (!parsedScopes.ok) {
        return { ok: false, error: parsedScopes.error };
    }
    const { plaintext, record } = await issueApiToken(userId, parsedLabel.label, parsedScopes.scopes);
    return { ok: true, plaintext, record };
}

export const tokensRoutes = new Hono<{ Variables: AuthVariables }>()
    .use('*', authenticateRequest)

    // POST /account/tokens — mint a new token. Plaintext is the only response field that
    // returns the secret; subsequent GETs never expose it.
    .post('/', async (c) => {
        const userId = c.get('session').user.id;
        const raw = await c.req.json<CreateBody>().catch(() => ({}) as CreateBody);
        const result = await mintTokenForUser(userId, raw);
        if (!result.ok) {
            return c.json({ error: result.error.message, code: result.error.code }, result.error.status);
        }
        return c.json({
            id: result.record._id,
            label: result.record.label,
            createdTs: result.record.createdTs,
            scopes: result.record.scopes ?? DEFAULT_API_TOKEN_SCOPES,
            plaintext: result.plaintext,
        });
    })

    // GET /account/tokens — list the caller's tokens (active + revoked).
    .get('/', async (c) => {
        const userId = c.get('session').user.id;
        const tokens = await apiTokensDAO.listForUser(userId);
        return c.json({ tokens: tokens.map(presentToken) });
    })

    // DELETE /account/tokens/:id — revoke a token. Idempotent: revoking an already-revoked token
    // still returns 200 so callers don't need separate code paths for "already gone".
    .delete('/:id', async (c) => {
        const userId = c.get('session').user.id;
        const id = c.req.param('id');
        const result = await apiTokensDAO.revokeById(id, userId, dayjs().toISOString());
        if (!result.matched) {
            return c.json({ error: 'token not found', code: 'not_found' }, 404);
        }
        return c.json({ ok: true });
    });
