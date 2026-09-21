/** Per-router CORS profile tests (issue #19 step 4).
 *
 * The two profiles live in `auth/corsProfiles.ts`. We exercise them through small Hono
 * harnesses that mirror how `index.ts` mounts each router, so we test the wiring as well
 * as the policy. Production-mode behaviour is asserted by stubbing NODE_ENV.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assistCors, publicCors, strictCors } from '../auth/corsProfiles.js';
import { clientUrl } from '../config.js';
import { v1RequestLogger } from '../lib/v1Logger.js';
import { v1ClaudeRoutes } from '../routes/v1/claude.js';
import { v1Routes } from '../routes/v1/index.js';
import { v1BriefGenerateRoutes } from '../routes/v1/itemBriefGenerate.js';

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

describe('assistCors (/v1/claude/* — the one credentialed /v1 exception)', () => {
    // Mirror index.ts's exact mount order: assistCors on /v1/claude/*, the claude route mounted
    // FIRST, then publicCors on /v1/* and the rest of /v1. Because the claude route fully handles
    // its request before the later publicCors `.use('/v1/*')` runs, publicCors can't clobber the
    // credentialed Allow-Origin back to `*`.
    function buildAssistApp() {
        return new Hono()
            .use('/v1/claude/*', assistCors())
            .post('/v1/claude/assist', (c) => c.json({ ok: true }))
            .use('/v1/*', publicCors())
            .post('/v1/items', (c) => c.json({ ok: true }));
    }

    beforeEach(() => {
        vi.stubEnv('NODE_ENV', 'production');
    });

    it('echoes the SPA origin and sends Access-Control-Allow-Credentials on preflight', async () => {
        const app = buildAssistApp();
        const res = await app.request('/v1/claude/assist', {
            method: 'OPTIONS',
            headers: { Origin: SPA_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe(SPA_ORIGIN);
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('rejects a foreign origin in production: no Allow-Origin header (CSRF backstop)', async () => {
        // Load-bearing: the session cookie is sameSite:'none' in prod (cross-domain SPA↔API), so it
        // rides cross-site. Pinning the origin to clientUrl is what stops a malicious page from
        // making a credentialed request that reads the proposal + minted executeToken. Echoing any
        // origin here would be a full read+write CSRF on a money-spending endpoint.
        const app = buildAssistApp();
        const res = await app.request('/v1/claude/assist', {
            method: 'OPTIONS',
            headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
        });
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('does NOT let publicCors clobber the credentialed headers on the actual POST', async () => {
        // The bug this guards: publicCors is mounted on /v1/* after the claude route. The claude
        // route handles the request first and returns, so publicCors never runs to reset Allow-Origin
        // to `*` (illegal with credentials) — the pinned origin + credentials survive to the response.
        const app = buildAssistApp();
        const res = await app.request('/v1/claude/assist', { method: 'POST', headers: { Origin: SPA_ORIGIN } });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe(SPA_ORIGIN);
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('still allows a no-Origin (bearer) request — external callers keep working', async () => {
        const app = buildAssistApp();
        const res = await app.request('/v1/claude/assist', { method: 'POST' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });

    it('leaves the rest of /v1 on publicCors (no credentials)', async () => {
        const app = buildAssistApp();
        const res = await app.request('/v1/items', {
            method: 'OPTIONS',
            headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' },
        });
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(res.headers.get('access-control-allow-credentials')).toBeNull();
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

/**
 * The REAL /v1 mount order from index.ts, with both cookie-authed exception routers. Guards the
 * catch-all leak: a `.use('*')` inside `v1ClaudeRoutes` expands to `/v1/*` and, mounted first,
 * would 401 every other /v1 preflight before its cors() runs.
 */
function buildRealV1App() {
    return new Hono()
        .use('/v1/claude/*', assistCors())
        .use('/v1/claude/*', v1RequestLogger())
        .route('/v1', v1ClaudeRoutes)
        .use('/v1/items/:id/brief/generate', assistCors())
        .use('/v1/items/:id/brief/generate', v1RequestLogger())
        .route('/v1', v1BriefGenerateRoutes)
        .use('/v1/*', publicCors())
        .use('/v1/*', v1RequestLogger())
        .route('/v1', v1Routes);
}

function preflight(app: Hono, path: string) {
    return app.request(path, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:4173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' },
    });
}

describe('/v1 mount order (index.ts) — cookie-authed exception routers do not leak onto sibling paths', () => {
    beforeEach(() => {
        vi.stubEnv('NODE_ENV', 'development');
    });

    it('answers the brief-generate preflight with the credentialed profile (was 401 with no CORS headers)', async () => {
        const res = await preflight(buildRealV1App(), '/v1/items/x/brief/generate');
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:4173');
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('answers the claude-assist preflight with the credentialed profile', async () => {
        const res = await preflight(buildRealV1App(), '/v1/claude/assist');
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('keeps every other /v1 path on the relaxed public profile', async () => {
        for (const path of ['/v1/people/x', '/v1/items/x', '/v1/items/x/brief', '/v1/items']) {
            const res = await preflight(buildRealV1App(), path);
            expect(res.status).toBe(204);
            expect(res.headers.get('access-control-allow-origin')).toBe('*');
            expect(res.headers.get('access-control-allow-credentials')).toBeNull();
        }
    });
});
