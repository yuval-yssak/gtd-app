/**
 * Thin HTTP client for the GTD public v1 API. Hand-written rather than generated so the MCP
 * package has zero runtime dependencies on the api-server source tree.
 */

export interface GtdClientConfig {
    baseUrl: string;
    token: string;
    /** Override the global fetch — used by tests. */
    fetchImpl?: typeof fetch;
}

export interface GtdItem {
    _id: string;
    user: string;
    status: string;
    title: string;
    notes?: string;
    externalId?: string;
    createdTs: string;
    updatedTs: string;
}

export interface ListItemsParams {
    q?: string;
    status?: string;
    since?: string;
    limit?: number;
    cursor?: string;
}

export interface ListItemsResponse {
    items: GtdItem[];
    nextCursor?: string;
}

export interface CreateInboxItemParams {
    title: string;
    notes?: string;
    externalId?: string;
}

export class GtdApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string | undefined,
        message: string,
    ) {
        super(message);
        this.name = 'GtdApiError';
    }
}

export class GtdClient {
    private readonly baseUrl: string;
    private readonly token: string;
    private readonly fetchImpl: typeof fetch;

    constructor(config: GtdClientConfig) {
        this.baseUrl = config.baseUrl.replace(/\/+$/, '');
        this.token = config.token;
        this.fetchImpl = config.fetchImpl ?? fetch;
    }

    async listItems(params: ListItemsParams = {}): Promise<ListItemsResponse> {
        const query = new URLSearchParams();
        if (params.q) query.set('q', params.q);
        if (params.status) query.set('status', params.status);
        if (params.since) query.set('since', params.since);
        if (params.limit !== undefined) query.set('limit', String(params.limit));
        if (params.cursor) query.set('cursor', params.cursor);
        const qs = query.toString();
        return this.request<ListItemsResponse>('GET', `/items${qs ? `?${qs}` : ''}`);
    }

    async getItem(id: string): Promise<GtdItem> {
        return this.request<GtdItem>('GET', `/items/${encodeURIComponent(id)}`);
    }

    async createInboxItem(params: CreateInboxItemParams): Promise<GtdItem> {
        return this.request<GtdItem>('POST', '/items', params);
    }

    async completeItem(id: string): Promise<GtdItem> {
        return this.request<GtdItem>('POST', `/items/${encodeURIComponent(id)}/complete`, {});
    }

    private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
        const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method,
            headers,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (!res.ok) {
            const errorBody = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
            throw new GtdApiError(res.status, errorBody.code, errorBody.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as T;
    }
}
