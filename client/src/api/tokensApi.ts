import { API_SERVER } from '../constants/globals';

export interface PersonalApiToken {
    id: string;
    label: string;
    createdTs: string;
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

export async function createToken(label: string): Promise<CreatedToken> {
    const res = await apiFetch('/account/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
    });
    return (await res.json()) as CreatedToken;
}

export async function revokeToken(id: string): Promise<void> {
    await apiFetch(`/account/tokens/${id}`, { method: 'DELETE' });
}
