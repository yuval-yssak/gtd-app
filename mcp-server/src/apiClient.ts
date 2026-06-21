import type { GtdEnvironment, McpConfig } from './config.js';

/**
 * Tiny fetch wrapper around the GTD /v1 surface. Adds the Authorization header for the
 * resolved account, parses JSON, and surfaces the API's structured error body verbatim —
 * including `extra: { status, field }` for status×field matrix violations so the model can
 * self-correct.
 *
 * **Multi-account.** Each `request()` accepts an optional `{ account, recipientAccount }` —
 * `account` selects which configured token signs the call (default `'default'`),
 * `recipientAccount` adds an `X-Reassign-Recipient-Token` header carrying that account's
 * bearer (used by `/v1/reassign`'s two-token consent gesture).
 */
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
    /** Account label whose token signs the call. Defaults to `'default'`. */
    account?: string;
    /**
     * Account label whose token is sent as `X-Reassign-Recipient-Token` — used by `/v1/reassign`
     * to prove the recipient consents to the move.
     */
    recipientAccount?: string;
}

export interface ApiClient {
    request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>, opts?: RequestOptions): Promise<T>;
    /** Configured account labels in env-var insertion order — drives `gtd_list_accounts` iteration. */
    listAccounts(): string[];
    /** The classified environment derived from `apiBase` (echoed in `gtd_me` / `gtd_list_accounts` responses). */
    environment(): GtdEnvironment;
    /** The normalised `apiBase` URL — pairs with `environment()` so tool output is unambiguous. */
    apiBase(): string;
    /** Browsable web-app origin for this environment, or `null` when it can't be derived (custom hosts). Used to stamp entity deep links. */
    webBase(): string | null;
}

const DEFAULT_ACCOUNT_LABEL = 'default';

export function createApiClient(config: McpConfig): ApiClient {
    return {
        listAccounts: () => [...config.tokens.keys()],
        environment: () => config.environment,
        apiBase: () => config.apiBase,
        webBase: () => config.webBase,
        async request(method, path, body, query, opts) {
            const account = opts?.account ?? DEFAULT_ACCOUNT_LABEL;
            const token = resolveToken(config, account);
            const headers: Record<string, string> = {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            };
            if (opts?.recipientAccount) {
                headers['X-Reassign-Recipient-Token'] = resolveToken(config, opts.recipientAccount);
            }
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

/**
 * Resolves an account label → token, throwing a structured `GtdApiError(400, 'unknown_account')`
 * when the label has no configured token. The label is normalised to lowercase to match
 * `loadConfig`'s key convention.
 */
function resolveToken(config: McpConfig, account: string): string {
    const normalised = account.toLowerCase();
    const token = config.tokens.get(normalised);
    if (!token) {
        throw new GtdApiError(`Unknown account "${account}". Configured accounts: ${[...config.tokens.keys()].join(', ') || '(none)'}`, 400, {
            code: 'unknown_account',
            account,
        });
    }
    return token;
}

function buildUrl(base: string, path: string, query?: Record<string, string | number | undefined>): string {
    // Strip trailing slashes from base and ensure leading slash on path so we never end up with
    // a `//` between host and path. loadConfig already does this for the configured base, but
    // doing it here too keeps the apiClient safe for direct programmatic instantiation (tests).
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
