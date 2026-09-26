import { expect, test } from '@playwright/test';

const API_URL = 'http://localhost:4000';

// GET /health is the Cloud Run startup-probe target (deploy-api.yml) and what an uptime check should
// assert on: a live API with a working Mongo connection answers 200 { status: 'ok' }. The 503 branch
// is covered by the api-server unit test (health.test.ts) — a Playwright run cannot take the
// webServer's database away without wedging every other spec.
test('GET /health reports ok, uncached, against a live API with a working database', async ({ request }) => {
    const res = await request.get(`${API_URL}/health`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    // Asserted alongside the 200: the global no-store middleware stamps a 404 too, so on its own this
    // header would pass without the route existing.
    expect(res.headers()['cache-control']).toContain('no-store');
});
