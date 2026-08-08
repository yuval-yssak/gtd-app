import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { strictCors } from '../auth/corsProfiles.js';
import { noStoreCache } from '../lib/noStoreCache.js';

const app = new Hono()
    .use('*', noStoreCache())
    .get('/ok', (c) => c.json({ ok: true }))
    .get('/revoked', (c) => c.json({ error: 'integration_revoked' }, 410))
    // Raw Response return — the /auth/* (Better Auth) and /sync/events (SSE) shape, where the
    // header landing on the response is non-obvious rather than trivially true.
    .get('/raw', () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));

// Mirrors the production topology in index.ts: noStoreCache global, CORS per-router.
const corsApp = new Hono()
    .use('*', noStoreCache())
    .use('/strict/*', strictCors())
    .get('/strict/ok', (c) => c.json({ ok: true }));

describe('noStoreCache middleware', () => {
    it('stamps Cache-Control: no-store on success responses', async () => {
        const res = await app.fetch(new Request('http://localhost/ok'));
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    it('stamps Cache-Control: no-store on heuristically-cacheable error statuses (410)', async () => {
        // 410 Gone is cacheable by default; without no-store the browser replays a pre-reconnect
        // integration_revoked response and a healed integration still looks revoked.
        const res = await app.fetch(new Request('http://localhost/revoked'));
        expect(res.status).toBe(410);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    it('stamps the header on a handler-returned raw Response (the /auth/* + SSE shape)', async () => {
        const res = await app.fetch(new Request('http://localhost/raw'));
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    it('survives a per-router CORS middleware on a normal response', async () => {
        const res = await corsApp.fetch(new Request('http://localhost/strict/ok', { headers: { Origin: 'http://localhost:4173' } }));
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    it('stamps the header on a CORS preflight short-circuit', async () => {
        // cors() answers OPTIONS with 204 without calling next(); noStoreCache is mounted outside
        // it so its post-next() write still runs. Guards against re-ordering in index.ts.
        const res = await corsApp.fetch(
            new Request('http://localhost/strict/ok', {
                method: 'OPTIONS',
                headers: { Origin: 'http://localhost:4173', 'Access-Control-Request-Method': 'GET' },
            }),
        );
        expect(res.status).toBe(204);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
    });
});
