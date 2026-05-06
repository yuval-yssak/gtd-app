/** Structured logging middleware (issue #19 step 10).
 *
 * `setup.ts` silences console.log globally. We re-spy here so we can assert the emitted line.
 */
/** biome-ignore-all lint/complexity/useLiteralKeys: log line is untyped JSON; bracket access is the documented shape. */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts mock call presence before reading. */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BearerVariables } from '../auth/bearerMiddleware.js';
import { v1RequestLogger } from '../lib/v1Logger.js';

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    logSpy.mockRestore();
});

function buildApp(opts: { withAuth?: boolean; replay?: boolean; status?: number } = {}) {
    return new Hono<{ Variables: BearerVariables }>().use('/v1/*', v1RequestLogger()).get('/v1/items', (c) => {
        if (opts.withAuth) {
            c.set('apiAuth', { userId: 'u1', tokenId: 'tok-1', scopes: ['items.read'] });
        }
        if (opts.replay) {
            c.header('X-Idempotent-Replay', 'true');
        }
        return c.json({ items: [] }, opts.status as 200 | undefined);
    });
}

function readLastLogLine(): Record<string, unknown> {
    expect(logSpy).toHaveBeenCalled();
    const lastCall = logSpy.mock.calls.at(-1)!;
    const line = lastCall[0];
    expect(typeof line).toBe('string');
    return JSON.parse(line as string);
}

describe('v1RequestLogger', () => {
    it('emits a JSON line with route, method, status, and durationMs', async () => {
        const app = buildApp();
        await app.request('/v1/items');
        const line = readLastLogLine();
        expect(line).toMatchObject({ scope: 'v1', route: '/v1/items', method: 'GET', status: 200, replayed: false });
        expect(typeof line['durationMs']).toBe('number');
    });

    it('includes userId and tokenId when the request was authenticated', async () => {
        const app = buildApp({ withAuth: true });
        await app.request('/v1/items');
        const line = readLastLogLine();
        expect(line['userId']).toBe('u1');
        expect(line['tokenId']).toBe('tok-1');
    });

    it('omits userId and tokenId when auth was not set (e.g. 401 path)', async () => {
        const app = buildApp();
        await app.request('/v1/items');
        const line = readLastLogLine();
        expect(line).not.toHaveProperty('userId');
        expect(line).not.toHaveProperty('tokenId');
    });

    it('sets replayed=true when the X-Idempotent-Replay header was emitted', async () => {
        const app = buildApp({ withAuth: true, replay: true });
        await app.request('/v1/items');
        const line = readLastLogLine();
        expect(line['replayed']).toBe(true);
    });

    it('emits a `ts` field that round-trips as ISO8601', async () => {
        const app = buildApp({ withAuth: true });
        await app.request('/v1/items');
        const line = readLastLogLine();
        expect(typeof line['ts']).toBe('string');
        // Date.parse accepts ISO 8601 — a quick sanity check that the format is reasonable.
        expect(Number.isNaN(Date.parse(line['ts'] as string))).toBe(false);
    });
});
