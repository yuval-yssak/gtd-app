import { API_SERVER } from '../constants/globals';

export type WebhookEvent = 'item.created' | 'item.completed';

export const ALL_WEBHOOK_EVENTS: WebhookEvent[] = ['item.created', 'item.completed'];

export interface WebhookSubscription {
    id: string;
    url: string;
    events: WebhookEvent[];
    createdTs: string;
    lastDeliveredTs?: string;
    failureCount?: number;
    disabledTs?: string;
    disabledReason?: string;
}

export interface CreatedWebhookSubscription {
    id: string;
    url: string;
    events: WebhookEvent[];
    createdTs: string;
    /** HMAC secret. Shown exactly once at creation. */
    secret: string;
}

export class WebhooksApiError extends Error {
    readonly status: number;
    readonly code: string | undefined;
    constructor(status: number, message: string, code: string | undefined) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

interface ErrorBody {
    error?: string;
    code?: string;
}

async function apiFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${API_SERVER}${path}`, {
        ...init,
        headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ErrorBody;
        throw new WebhooksApiError(response.status, body.error ?? `webhooks API error ${response.status}`, body.code);
    }
    return response;
}

export async function listWebhooks(token: string): Promise<WebhookSubscription[]> {
    const res = await apiFetch('/v1/webhooks', token);
    const body = (await res.json()) as { subscriptions: WebhookSubscription[] };
    return body.subscriptions;
}

export async function createWebhook(token: string, url: string, events: WebhookEvent[]): Promise<CreatedWebhookSubscription> {
    const res = await apiFetch('/v1/webhooks', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, events }),
    });
    return (await res.json()) as CreatedWebhookSubscription;
}

export async function deleteWebhook(token: string, id: string): Promise<void> {
    await apiFetch(`/v1/webhooks/${id}`, token, { method: 'DELETE' });
}
