/** The two brief maintenance routes (routes/maintenance.ts): the cron-secret gate + limit clamp on
 * /briefs/sweep, and session auth + caller scoping on /briefs/sweep-mine. The sweeps are mocked. */
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CRON_SECRET_HEADER } from '../auth/cronSecret.js';
import { auth, closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { clampSweepLimit, maintenanceRoutes } from '../routes/maintenance.js';
import { oauthLogin, SESSION_COOKIE } from './helpers.js';

const runBriefSweep = vi.fn();
vi.mock('../lib/brief/briefSweep.js', () => ({ runBriefSweep: (...args: unknown[]) => runBriefSweep(...args) }));

const startReviewBriefSweep = vi.fn();
vi.mock('../lib/brief/briefSweepMine.js', () => ({ startReviewBriefSweep: (...args: unknown[]) => startReviewBriefSweep(...args) }));

const app = new Hono().on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw)).route('/maintenance', maintenanceRoutes);

const SWEEP_SUMMARY = { harvest: { harvested: 0 }, submit: { submitted: 4, skipped: 1, inFlight: false } };
const MINE_SUMMARY = { started: 3, skippedWritten: 2, cooldown: false };

beforeAll(async () => {
    await loadDataAccess('gtd_test_maintenance_briefs');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all(['user', 'session', 'account', 'verification'].map((name) => db.collection(name).deleteMany({})));
    runBriefSweep.mockReset().mockResolvedValue(SWEEP_SUMMARY);
    startReviewBriefSweep.mockReset().mockResolvedValue(MINE_SUMMARY);
    vi.stubEnv('CRON_SECRET', 'cron-s3cret');
});

afterEach(() => {
    vi.unstubAllEnvs();
});

function sweep(headers: Record<string, string>, body?: unknown) {
    return app.fetch(
        new Request('http://localhost:4000/maintenance/briefs/sweep', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
    );
}

async function login(provider: 'google' | 'github' = 'google', overrides: Record<string, unknown> = {}): Promise<{ userId: string; sessionCookie: string }> {
    const { sessionCookie } = await oauthLogin(app, provider, overrides);
    if (!sessionCookie) throw new Error('login produced no session cookie');
    const res = await app.fetch(new Request('http://localhost:4000/auth/get-session', { headers: { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } }));
    const { user } = (await res.json()) as { user: { id: string } };
    return { userId: user.id, sessionCookie };
}

function sweepMine(sessionCookie?: string) {
    return app.fetch(
        new Request('http://localhost:4000/maintenance/briefs/sweep-mine', {
            method: 'POST',
            headers: sessionCookie ? { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } : {},
        }),
    );
}

describe('clampSweepLimit', () => {
    it('clamps numbers into [1, 2000], floors fractions, and defaults everything else to 2000', () => {
        expect(clampSweepLimit(0)).toBe(1);
        expect(clampSweepLimit(-5)).toBe(1);
        expect(clampSweepLimit(7.9)).toBe(7);
        expect(clampSweepLimit(2000)).toBe(2000);
        expect(clampSweepLimit(5000)).toBe(2000);
        expect(clampSweepLimit(undefined)).toBe(2000);
        expect(clampSweepLimit('10')).toBe(2000);
        expect(clampSweepLimit(Number.NaN)).toBe(2000);
    });
});

describe('POST /maintenance/briefs/sweep', () => {
    it('401s without the cron secret, on a mismatch, and for a session cookie instead of the secret', async () => {
        const { sessionCookie } = await login();
        expect((await sweep({})).status).toBe(401);
        expect((await sweep({ [CRON_SECRET_HEADER]: 'wrong' })).status).toBe(401);
        expect((await sweep({ Cookie: `${SESSION_COOKIE}=${sessionCookie}` })).status).toBe(401);
        expect(runBriefSweep).not.toHaveBeenCalled();
    });

    it('runs the sweep with the clamped limit and returns its summary', async () => {
        const res = await sweep({ [CRON_SECRET_HEADER]: 'cron-s3cret' }, { limit: 9999 });
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual(SWEEP_SUMMARY);
        expect(runBriefSweep).toHaveBeenCalledWith({ limit: 2000 });
    });

    it('defaults the limit when the body is missing or not JSON', async () => {
        expect((await sweep({ [CRON_SECRET_HEADER]: 'cron-s3cret' })).status).toBe(200);
        expect(runBriefSweep).toHaveBeenLastCalledWith({ limit: 2000 });
        const res = await app.fetch(
            new Request('http://localhost:4000/maintenance/briefs/sweep', { method: 'POST', headers: { [CRON_SECRET_HEADER]: 'cron-s3cret' }, body: 'nope' }),
        );
        expect(res.status).toBe(200);
        expect(runBriefSweep).toHaveBeenLastCalledWith({ limit: 2000 });
        await sweep({ [CRON_SECRET_HEADER]: 'cron-s3cret' }, { limit: 12 });
        expect(runBriefSweep).toHaveBeenLastCalledWith({ limit: 12 });
    });
});

describe('POST /maintenance/briefs/sweep-mine', () => {
    it('401s without a session — the cron secret is not a substitute', async () => {
        expect((await sweepMine()).status).toBe(401);
        const res = await app.fetch(
            new Request('http://localhost:4000/maintenance/briefs/sweep-mine', { method: 'POST', headers: { [CRON_SECRET_HEADER]: 'cron-s3cret' } }),
        );
        expect(res.status).toBe(401);
        expect(startReviewBriefSweep).not.toHaveBeenCalled();
    });

    it('starts the sweep for the session user only and returns its result', async () => {
        const alice = await login();
        const bob = await login('github', { email: 'bob@example.com', login: 'bob-gh' });

        const res = await sweepMine(alice.sessionCookie);
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual(MINE_SUMMARY);
        expect(startReviewBriefSweep).toHaveBeenCalledTimes(1);
        expect(startReviewBriefSweep).toHaveBeenCalledWith(alice.userId);

        startReviewBriefSweep.mockResolvedValueOnce({ started: 0, cooldown: true });
        const again = await sweepMine(bob.sessionCookie);
        expect(again.status).toBe(200);
        await expect(again.json()).resolves.toEqual({ started: 0, cooldown: true });
        expect(startReviewBriefSweep).toHaveBeenLastCalledWith(bob.userId);
    });
});
