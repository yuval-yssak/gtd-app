import { API_SERVER } from '../constants/globals';

/**
 * Capability scopes the API understands. `items.clarify` is the legacy form: tokens minted before
 * the Phase 2 scope extension carry it, the server backfills `items.write` in-memory at auth time,
 * and the mint endpoint rejects new tokens that ask for it. Kept in the type union so the settings
 * UI can display it on legacy rows; `MINTABLE_API_TOKEN_SCOPES` is the set users can actually pick.
 */
export type ApiTokenScope =
    | 'items.capture'
    | 'items.read'
    | 'items.write'
    | 'items.clarify'
    | 'routines.read'
    | 'routines.write'
    | 'people.read'
    | 'people.write'
    | 'contexts.read'
    | 'contexts.write'
    | 'reassign'
    | 'reassign.accept'
    | 'webhooks.manage';

/** Scopes the user can pick when minting a new token. Excludes the legacy `items.clarify`. */
export const MINTABLE_API_TOKEN_SCOPES: ApiTokenScope[] = [
    'items.capture',
    'items.read',
    'items.write',
    'routines.read',
    'routines.write',
    'people.read',
    'people.write',
    'contexts.read',
    'contexts.write',
    'reassign',
    'reassign.accept',
    'webhooks.manage',
];
export const DEFAULT_NEW_TOKEN_SCOPES: ApiTokenScope[] = ['items.capture', 'items.read'];

export interface PersonalApiToken {
    id: string;
    label: string;
    createdTs: string;
    scopes: ApiTokenScope[];
    lastUsedTs?: string;
    revokedTs?: string;
}

/**
 * Returned only by `createToken`. The plaintext field appears in this response *exactly once*
 * — the server stores only the sha256 hash, so no other endpoint can ever re-derive it.
 */
export interface CreatedToken {
    id: string;
    label: string;
    createdTs: string;
    scopes: ApiTokenScope[];
    plaintext: string;
}

interface ErrorBody {
    error?: string;
    code?: string;
}

/** Thin wrapper around fetch that surfaces the server's `code` so callers can branch on errors like `token_cap_reached`. */
export class TokensApiError extends Error {
    readonly status: number;
    readonly code: string | undefined;
    constructor(status: number, message: string, code: string | undefined) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
    // credentials: 'include' — Better Auth session cookie travels cross-origin (client ≠ API domain).
    const response = await fetch(`${API_SERVER}${path}`, { credentials: 'include', ...init });
    if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ErrorBody;
        throw new TokensApiError(response.status, body.error ?? `tokens API error ${response.status}`, body.code);
    }
    return response;
}

export async function listTokens(): Promise<PersonalApiToken[]> {
    const res = await apiFetch('/account/tokens');
    const body = (await res.json()) as { tokens: PersonalApiToken[] };
    return body.tokens;
}

export async function createToken(label: string, scopes?: ApiTokenScope[]): Promise<CreatedToken> {
    const body = scopes !== undefined ? { label, scopes } : { label };
    const res = await apiFetch('/account/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return (await res.json()) as CreatedToken;
}

export async function revokeToken(id: string): Promise<void> {
    await apiFetch(`/account/tokens/${id}`, { method: 'DELETE' });
}
