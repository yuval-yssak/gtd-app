import { createMiddleware } from 'hono/factory';

/**
 * Stamps `Cache-Control: no-store` on every response so browsers never reuse API responses from
 * their HTTP cache. Without an explicit header, heuristically-cacheable statuses (404, 410, 301…)
 * get replayed by the browser: a `410 integration_revoked` from a calendar endpoint kept being
 * served from cache after a successful OAuth reconnect, making the integration look permanently
 * revoked until a hard reload.
 */
export function noStoreCache() {
    return createMiddleware(async (c, next) => {
        await next();
        c.res.headers.set('Cache-Control', 'no-store');
    });
}
