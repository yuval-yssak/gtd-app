import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type APIRequestContext, type Browser, type BrowserContext, expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice } from './helpers/context';

const API_URL = 'http://localhost:4000';

/**
 * Ends-to-end webhook delivery test (issue #19 step 8).
 *
 * Runs a tiny in-process HTTP server inside the Playwright runner, registers it as a webhook
 * URL, fires an item-creation through /v1/items, and asserts the receiver gets a signed POST
 * within the worker's tick interval (5s). In dev/test the delivery worker runs by default
 * (`api-server/src/index.ts`); production requires `WEBHOOKS_ENABLED=true` explicitly.
 */

interface ReceivedDelivery {
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

interface ReceiverHandle {
    server: Server;
    url: string;
    received: ReceivedDelivery[];
}

async function startReceiver(port = 0): Promise<ReceiverHandle> {
    const received: ReceivedDelivery[] = [];
    const server = createServer((req: IncomingMessage, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
            res.statusCode = 200;
            res.end('ok');
        });
    });
    await new Promise<void>((resolve) => server.listen(port, resolve));
    const address = server.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : port;
    return { server, url: `http://localhost:${actualPort}/`, received };
}

async function withBearerOnlyContext(browser: Browser, fn: (ctx: BrowserContext) => Promise<void>): Promise<void> {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
        await fn(ctx);
    } finally {
        await ctx.close();
    }
}

async function mintToken(request: APIRequestContext, scopes: string[]): Promise<string> {
    const res = await request.post(`${API_URL}/account/tokens`, { data: { label: 'webhook-e2e', scopes } });
    expect(res.status()).toBe(200);
    return ((await res.json()) as { plaintext: string }).plaintext;
}

test.describe('webhooks', () => {
    test('item.created event fires a signed POST to the registered URL', async ({ browser }) => {
        const email = `webhooks-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        const receiver = await startReceiver();
        try {
            await withOneLoggedInDevice(browser, email, async (page) => {
                const session = page.context().request;
                const captureToken = await mintToken(session, ['items.capture', 'items.read']);
                const manageToken = await mintToken(session, ['webhooks.manage']);

                // Subscribe via /v1/webhooks (manage scope).
                await withBearerOnlyContext(browser, async (apiContext) => {
                    const sub = await apiContext.request.post(`${API_URL}/v1/webhooks`, {
                        headers: { Authorization: `Bearer ${manageToken}` },
                        data: { url: receiver.url, events: ['item.created'] },
                    });
                    expect(sub.status()).toBe(200);
                    const subBody = (await sub.json()) as { id: string; secret: string };
                    expect(subBody.secret.length).toBeGreaterThan(20);

                    // Fire an inbox capture (capture scope) so the worker enqueues a delivery.
                    const created = await apiContext.request.post(`${API_URL}/v1/items`, {
                        headers: { Authorization: `Bearer ${captureToken}` },
                        data: { title: 'webhook trigger', externalId: 'webhook-1' },
                    });
                    expect(created.status()).toBe(201);

                    // Wait up to 15s for the worker to deliver. Worker tick is 5s; one delivery should arrive in <10s.
                    const deadline = Date.now() + 15_000;
                    while (Date.now() < deadline && receiver.received.length === 0) {
                        await new Promise((r) => setTimeout(r, 250));
                    }
                    expect(
                        receiver.received.length,
                        'Expected at least one webhook delivery within 15s. The dev server starts the worker by default; check api-server logs for "[webhooks] delivery worker started".',
                    ).toBeGreaterThan(0);

                    const delivery = receiver.received[0]!;
                    expect(delivery.headers['x-gtd-event']).toBe('item.created');
                    expect(delivery.headers['x-gtd-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
                    expect(delivery.headers['x-gtd-delivery-id']).toBeTruthy();

                    const payload = JSON.parse(delivery.body) as { event: string; item: { title: string } };
                    expect(payload.event).toBe('item.created');
                    expect(payload.item.title).toBe('webhook trigger');
                });
            });
        } finally {
            await new Promise<void>((resolve) => receiver.server.close(() => resolve()));
        }
    });
});
