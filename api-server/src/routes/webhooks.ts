import { randomBytes, randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import { Hono } from 'hono';
import { authenticateBearer, type BearerVariables } from '../auth/bearerMiddleware.js';
import { authenticatedRateLimit } from '../auth/rateLimitMiddleware.js';
import { requireScope } from '../auth/scopeMiddleware.js';
import webhookSubscriptionsDAO from '../dataAccess/webhookSubscriptionsDAO.js';
import { VALID_WEBHOOK_EVENTS, type WebhookEvent, type WebhookSubscriptionInterface } from '../types/entities.js';

/** Per-user cap on active webhook subscriptions. Tuned similarly to the token cap — UX guardrail, not security boundary. */
export const WEBHOOK_SUBSCRIPTION_CAP_PER_USER = 10;

interface PublicSubscriptionView {
    id: string;
    url: string;
    events: WebhookEvent[];
    createdTs: string;
    lastDeliveredTs?: string;
    failureCount?: number;
    disabledTs?: string;
    disabledReason?: string;
}

/** Strips `secret` and `user` so neither leaks. Secret is shown once at creation only. */
function presentSubscription(sub: WebhookSubscriptionInterface): PublicSubscriptionView {
    const view: PublicSubscriptionView = { id: sub._id, url: sub.url, events: sub.events, createdTs: sub.createdTs };
    if (sub.lastDeliveredTs !== undefined) view.lastDeliveredTs = sub.lastDeliveredTs;
    if (sub.failureCount !== undefined) view.failureCount = sub.failureCount;
    if (sub.disabledTs !== undefined) view.disabledTs = sub.disabledTs;
    if (sub.disabledReason !== undefined) view.disabledReason = sub.disabledReason;
    return view;
}

interface CreateBody {
    url?: unknown;
    events?: unknown;
}

type CreateError =
    | { status: 400; code: 'invalid_url' | 'invalid_events' | 'invalid_body'; message: string }
    | { status: 429; code: 'subscription_cap_reached'; message: string };

function parseCreateBody(raw: CreateBody): { ok: true; url: string; events: WebhookEvent[] } | { ok: false; error: CreateError } {
    if (typeof raw.url !== 'string' || raw.url.trim() === '') {
        return { ok: false, error: { status: 400, code: 'invalid_url', message: 'url must be a non-empty string' } };
    }
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(raw.url);
    } catch {
        return { ok: false, error: { status: 400, code: 'invalid_url', message: 'url is not a valid URL' } };
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        return { ok: false, error: { status: 400, code: 'invalid_url', message: 'url must use http or https' } };
    }
    if (!Array.isArray(raw.events) || raw.events.length === 0) {
        return { ok: false, error: { status: 400, code: 'invalid_events', message: 'events must be a non-empty array of event names' } };
    }
    const seen = new Set<WebhookEvent>();
    for (const e of raw.events) {
        if (typeof e !== 'string' || !VALID_WEBHOOK_EVENTS.has(e as WebhookEvent)) {
            return {
                ok: false,
                error: { status: 400, code: 'invalid_events', message: `unknown event ${JSON.stringify(e)}; allowed: ${[...VALID_WEBHOOK_EVENTS].join(', ')}` },
            };
        }
        seen.add(e as WebhookEvent);
    }
    return { ok: true, url: raw.url, events: [...seen] };
}

/** Generates the HMAC secret. Same approach as `generateTokenPlaintext`: 32 random bytes, base64url-encoded. */
function generateWebhookSecret(): string {
    return randomBytes(32).toString('base64url');
}

export const webhookRoutes = new Hono<{ Variables: BearerVariables }>()
    .use('*', authenticateBearer)
    .use('*', authenticatedRateLimit())

    // POST /v1/webhooks — register a new subscription. Returns the secret exactly once.
    .post('/', requireScope('webhooks.manage'), async (c) => {
        const userId = c.var.apiAuth.userId;
        const raw = (await c.req.json<CreateBody>().catch(() => ({}) as CreateBody)) ?? {};
        const parsed = parseCreateBody(raw);
        if (!parsed.ok) {
            return c.json({ error: parsed.error.message, code: parsed.error.code }, parsed.error.status);
        }
        const active = await webhookSubscriptionsDAO.countActiveForUser(userId);
        if (active >= WEBHOOK_SUBSCRIPTION_CAP_PER_USER) {
            return c.json(
                {
                    error: `Subscription cap reached (${WEBHOOK_SUBSCRIPTION_CAP_PER_USER}). Delete unused subscriptions before adding new ones.`,
                    code: 'subscription_cap_reached',
                },
                429,
            );
        }
        const record: WebhookSubscriptionInterface = {
            _id: randomUUID(),
            user: userId,
            url: parsed.url,
            events: parsed.events,
            secret: generateWebhookSecret(),
            createdTs: dayjs().toISOString(),
        };
        await webhookSubscriptionsDAO.insertOne(record);
        return c.json({ id: record._id, url: record.url, events: record.events, createdTs: record.createdTs, secret: record.secret });
    })

    // GET /v1/webhooks — list the caller's subscriptions. Secret is never returned.
    .get('/', requireScope('webhooks.manage'), async (c) => {
        const userId = c.var.apiAuth.userId;
        const subs = await webhookSubscriptionsDAO.listForUser(userId);
        return c.json({ subscriptions: subs.map(presentSubscription) });
    })

    // DELETE /v1/webhooks/:id — delete a subscription (hard delete; deliveries already enqueued
    // remain in the audit log but new events are not enqueued).
    .delete('/:id', requireScope('webhooks.manage'), async (c) => {
        const userId = c.var.apiAuth.userId;
        const id = c.req.param('id');
        const existing = await webhookSubscriptionsDAO.findOne({ _id: id, user: userId });
        if (!existing) {
            return c.json({ error: 'subscription not found', code: 'not_found' }, 404);
        }
        await webhookSubscriptionsDAO.deleteByOwner(id, userId);
        return c.json({ ok: true });
    });
