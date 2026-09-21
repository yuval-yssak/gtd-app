/** Shared Cloud Scheduler gate (auth/cronSecret.ts): the pure check and the middleware wiring. */
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRON_SECRET_HEADER, isCronSecretValid, requireCronSecret } from '../auth/cronSecret.js';

const app = new Hono().post('/tick', requireCronSecret(), (c) => c.json({ ok: true }));

function tick(headers: Record<string, string> = {}) {
    return app.fetch(new Request('http://localhost/tick', { method: 'POST', headers }));
}

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('isCronSecretValid', () => {
    it('accepts only a non-empty exact match', () => {
        expect(isCronSecretValid('s3cret', 's3cret')).toBe(true);
        expect(isCronSecretValid('s3cret', 's3cret ')).toBe(false);
        expect(isCronSecretValid('S3CRET', 's3cret')).toBe(false);
        expect(isCronSecretValid('', '')).toBe(false);
    });

    it('fails closed when the expected value is unset or empty — even for an empty guess', () => {
        expect(isCronSecretValid('anything', undefined)).toBe(false);
        expect(isCronSecretValid('anything', '')).toBe(false);
        expect(isCronSecretValid(undefined, 's3cret')).toBe(false);
    });
});

describe('requireCronSecret', () => {
    it('401s without the header and on a mismatch', async () => {
        vi.stubEnv('CRON_SECRET', 's3cret');
        expect((await tick()).status).toBe(401);
        expect((await tick({ [CRON_SECRET_HEADER]: 'wrong' })).status).toBe(401);
    });

    it('401s every caller while CRON_SECRET is unset (same status as a mismatch — no probe signal)', async () => {
        vi.stubEnv('CRON_SECRET', '');
        expect((await tick({ [CRON_SECRET_HEADER]: '' })).status).toBe(401);
        expect((await tick({ [CRON_SECRET_HEADER]: 'guess' })).status).toBe(401);
    });

    it('passes the request through on a match', async () => {
        vi.stubEnv('CRON_SECRET', 's3cret');
        const res = await tick({ [CRON_SECRET_HEADER]: 's3cret' });
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ ok: true });
    });
});
