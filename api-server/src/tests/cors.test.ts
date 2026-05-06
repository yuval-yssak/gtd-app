/** Per-router CORS profile tests (issue #19 step 4).
 *
 * The two profiles live in `auth/corsProfiles.ts`. We exercise them through small Hono
 * harnesses that mirror how `index.ts` mounts each router, so we test the wiring as well
 * as the policy. Production-mode behaviour is asserted by stubbing NODE_ENV.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publicCors, strictCors } from '../auth/corsProfiles.js';
import { clientUrl } from '../config.js';

// `clientUrl` is captured at module-load time from process.env.CLIENT_URL — we use the captured
// value directly so the test passes regardless of whether the env var was set before vitest started.
const SPA_ORIGIN = clientUrl;

function buildStrictApp() {
    return new Hono().use('/sync/*', strictCors()).post('/sync/push', (c) => c.json({ ok: true }));
}

function buildPublicApp() {
    return new Hono().use('/v1/*', publicCors()).post('/v1/items', (c) => c.json({ ok: true }));
}

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('strictCors (cookie-authed routes)', () => {
    describe('production', () => {
        beforeEach(() => {
            vi.stubEnv('NODE_ENV', 'production');
        });

        it('allows the SPA origin and includes Access-Control-Allow-Credentials', async () => {
            const app = buildStrictApp();
            const res = await app.request('/sync/push', {
                method: 'OPTIONS',
                headers: {
                    Origin: SPA_ORIGIN,
                    'Access-Control-Request-Method': 'POST',
                    'Access-Control-Request-Headers': 'Content-Type',
                },
            });
            // Hono's cors() responds 204 to a successful preflight.
            expect(res.status).toBe(204);
            expect(res.headers.get('access-control-allow-origin')).toBe(SPA_ORIGIN);
            expect(res.headers.get('access-control-allow-credentials')).toBe('true');
        });

        it('rejects a foreign origin in production: no allow-origin header', async () => {
            const app = buildStrictApp();
            const res = await app.request('/sync/push', {
                method: 'OPTIONS',
                headers: {
                    Origin: 'https://evil.example',
                    'Access-Control-Request-Method': 'POST',
                },
            });
            // Hono returns 204 for the preflight regardless; the cross-origin protection comes
            // from the missing Allow-Origin header — the browser is what enforces the policy.
            expect(res.headers.get('access-control-allow-origin')).toBeNull();
        });
    });

    describe('non-production', () => {
        beforeEach(() => {
            vi.stubEnv('NODE_ENV', 'development');
        });

        it('echoes any origin so dev tooling and ngrok work', async () => {
            const app = buildStrictApp();
            const res = await app.request('/sync/push', {
                method: 'OPTIONS',
                headers: {
                    Origin: 'https://anything.example',
                    'Access-Control-Request-Method': 'POST',
                },
            });
            expect(res.headers.get('access-control-allow-origin')).toBe('https://anything.example');
        });
    });
});

describe('publicCors (/v1 bearer-authed routes)', () => {
    beforeEach(() => {
        vi.stubEnv('NODE_ENV', 'production');
    });

    it('allows any origin without credentials', async () => {
        const app = buildPublicApp();
        const res = await app.request('/v1/items', {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://example.com',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'Authorization',
            },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        // No credentials header on a relaxed-public endpoint — bearer doesn't need cookies.
        expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    });

    it('advertises the methods the v1 surface supports (GET, POST, PATCH)', async () => {
        const app = buildPublicApp();
        const res = await app.request('/v1/items', {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://example.com',
                'Access-Control-Request-Method': 'PATCH',
            },
        });
        const methods = res.headers.get('access-control-allow-methods') ?? '';
        expect(methods).toContain('GET');
        expect(methods).toContain('POST');
        expect(methods).toContain('PATCH');
        expect(methods).toContain('OPTIONS');
    });

    it('allows the Authorization header on the request', async () => {
        const app = buildPublicApp();
        const res = await app.request('/v1/items', {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://example.com',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'Authorization',
            },
        });
        expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
    });
});

describe('combined application: /v1 cross-origin allowed, /sync/push not', () => {
    beforeEach(() => {
        vi.stubEnv('NODE_ENV', 'production');
    });

    it('routes the same Origin to two different policies', async () => {
        const app = new Hono()
            .use('/v1/*', publicCors())
            .post('/v1/items', (c) => c.json({ ok: true }))
            .use('/sync/*', strictCors())
            .post('/sync/push', (c) => c.json({ ok: true }));

        const v1 = await app.request('/v1/items', {
            method: 'OPTIONS',
            headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' },
        });
        expect(v1.headers.get('access-control-allow-origin')).toBe('*');

        const syncReq = await app.request('/sync/push', {
            method: 'OPTIONS',
            headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' },
        });
        expect(syncReq.headers.get('access-control-allow-origin')).toBeNull();
    });
});
