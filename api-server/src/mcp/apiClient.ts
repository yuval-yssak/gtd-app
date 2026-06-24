/**
 * Single-token ApiClient for the REMOTE (HTTP-mounted) MCP server.
 *
 * Adapted from mcp-server/src/apiClient.ts — keeps the SAME `ApiClient` interface and `GtdApiError`
 * so the copied tool modules compile unchanged, but the multi-account model is dropped: a remote
 * `/mcp` connection is one authenticated caller = one token. `request()` therefore IGNORES
 * `opts.account` / `opts.recipientAccount` (they exist only so the copied tools type-check) and
 * always attaches the single bound bearer. `listAccounts()` returns the single `'default'` label.
 *
 * Multi-tenancy is enforced upstream: the bearer is the caller's own OAuth/personal access token,
 * so every `/v1/*` call is scoped to that user by `authenticateBearer`. A client-supplied account
 * label can never select a different user — see REMOTE_MCP_PLAN.md "Multi-tenancy note".
 */
import type { GtdEnvironment } from './webBase.js';

export interface ApiError extends Error {
    status: number;
    code?: string;
    body?: unknown;
}

export class GtdApiError extends Error implements ApiError {
    status: number;
    code?: string;
    body?: unknown;
    constructor(message: string, status: number, body?: unknown) {
        super(message);
        this.name = 'GtdApiError';
        this.status = status;
        const code = (body as { code?: unknown } | undefined)?.code;
        if (typeof code === 'string') {
            this.code = code;
        }
        this.body = body;
    }
}

export interface RequestOptions {
    /** Accepted for source-parity with the copied tools; ignored — the bound token always signs. */
    account?: string;
    /** Accepted for source-parity (reassign); ignored remotely — there is no second token. */
    recipientAccount?: string;
}

export interface ApiClient {
    request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>, opts?: RequestOptions): Promise<T>;
    /** The single configured account label — always `['default']` remotely. */
    listAccounts(): string[];
    environment(): GtdEnvironment;
    apiBase(): string;
    webBase(): string | null;
}

const SINGLE_ACCOUNT_LABEL = 'default';

/** Immutable config the remote client is constructed with, per authenticated request. */
export interface RemoteApiClientConfig {
    apiBase: string;
    environment: GtdEnvironment;
    webBase: string | null;
    /** The caller's bearer token (OAuth access token or personal `gtd_` token). */
    token: string;
}

export function createRemoteApiClient(config: RemoteApiClientConfig): ApiClient {
    return {
        listAccounts: () => [SINGLE_ACCOUNT_LABEL],
        environment: () => config.environment,
        apiBase: () => config.apiBase,
        webBase: () => config.webBase,
        async request(method, path, body, query, opts) {
            // A remote connection is one authenticated caller = one token. Any request targeting a
            // NON-default account (or a recipient token, e.g. gtd_reassign's cross-account move) cannot
            // be honored with a single token — fail loudly rather than silently resolving to the caller,
            // which would otherwise turn a cross-account reassign into a confusing self-reassign.
            const account = opts?.account;
            if ((account && account.toLowerCase() !== SINGLE_ACCOUNT_LABEL) || opts?.recipientAccount) {
                throw new GtdApiError(
                    'Multi-account operations are not available over the remote MCP server — each connection is scoped to a single account. Use a separate MCP connection per account.',
                    400,
                    { code: 'multi_account_unsupported' },
                );
            }
            const headers: Record<string, string> = {
                Authorization: `Bearer ${config.token}`,
                Accept: 'application/json',
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            };
            const init: RequestInit = { method, headers };
            if (body !== undefined) {
                init.body = JSON.stringify(body);
            }
            const url = buildUrl(config.apiBase, path, query);
            const res = await fetch(url, init);
            const text = await res.text();
            const parsed = text.length > 0 ? safeJsonParse(text) : undefined;
            if (!res.ok) {
                const message = extractMessage(parsed) ?? `HTTP ${res.status}`;
                throw new GtdApiError(message, res.status, parsed);
            }
            return parsed as never;
        },
    };
}

function buildUrl(base: string, path: string, query?: Record<string, string | number | undefined>): string {
    const trimmedBase = base.replace(/\/+$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${trimmedBase}${normalizedPath}`);
    if (query) {
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined && value !== '') {
                url.searchParams.set(key, String(value));
            }
        }
    }
    return url.toString();
}

function safeJsonParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function extractMessage(body: unknown): string | null {
    if (body && typeof body === 'object' && 'error' in body) {
        const error = (body as { error?: unknown }).error;
        if (typeof error === 'string') {
            return error;
        }
    }
    return null;
}
