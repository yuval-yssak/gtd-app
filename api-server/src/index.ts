import { execSync } from 'node:child_process';
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { publicCors, strictCors } from './auth/corsProfiles.js';
import { v1RequestLogger } from './lib/v1Logger.js';
import { auth, loadDataAccess } from './loaders/mainLoader.js';
import { calendarRoutes } from './routes/calendar.js';
import { deviceRoutes } from './routes/devices.js';
import { pushRoutes } from './routes/push.js';
import { syncRoutes } from './routes/sync.js';
import { tokensRoutes } from './routes/tokens.js';
import { v1Routes } from './routes/v1/index.js';
import { webhookRoutes } from './routes/webhooks.js';

function resolveCommitHash() {
    try {
        return execSync('git rev-parse --short HEAD').toString().trim();
    } catch {
        return 'unknown';
    }
}

const COMMIT_HASH = process.env.COMMIT_HASH ?? resolveCommitHash();

// CORS is applied per-router rather than globally (issue #19 step 4): cookie-authed routes get
// the strict profile (origin = clientUrl in prod), and the bearer-authed /v1 router gets the
// public profile (origin = '*'). See `auth/corsProfiles.ts` for the rationale.
const app = new Hono()
    // auth is a live ESM binding — assigned in loadDataAccess() before serve() is called, so it's safe to reference lazily here.
    // CORS for /auth/* must come before the handler so OPTIONS preflight is answered correctly.
    .use('/auth/*', strictCors())
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .use('/sync/*', strictCors())
    .route('/sync', syncRoutes)
    .use('/push/*', strictCors())
    .route('/push', pushRoutes)
    .use('/devices/*', strictCors())
    .route('/devices', deviceRoutes)
    .use('/calendar/*', strictCors())
    .route('/calendar', calendarRoutes)
    // /v1 is the public bearer-authed surface — relaxed CORS so external integrations can call it
    // from any origin. The bearer token is the auth gate.
    .use('/v1/*', publicCors())
    // v1RequestLogger emits one structured JSON line per /v1/* request. Mounted before the
    // routers so it captures durations across auth, rate-limit, and the handler.
    .use('/v1/*', v1RequestLogger())
    .route('/v1', v1Routes)
    .route('/v1/webhooks', webhookRoutes)
    // /account/tokens lives outside /v1 because it is session-authed (cookie), not bearer-authed.
    // Bearer-only token mint would be a chicken-and-egg.
    .use('/account/tokens/*', strictCors())
    .route('/account/tokens', tokensRoutes)
    .get('/version', (c) => c.json({ commitHash: COMMIT_HASH }));

// Exported for Hono RPC — client imports this type to get a fully-typed fetch client
export type AppType = typeof app;

async function start() {
    await loadDataAccess();

    // Dynamic import so the module (and its production guard) is never evaluated in production.
    if (process.env.NODE_ENV !== 'production') {
        const { devLoginRoutes } = await import('./routes/devLogin.js');
        // /dev is hit by the e2e helpers and the dev console; same strict-CORS profile so
        // browser-driven dev login keeps working with credentials cross-origin.
        app.use('/dev/*', strictCors());
        app.route('/dev', devLoginRoutes);
    }

    // Keep Google Calendar webhook channels alive without Cloud Scheduler.
    if (process.env.CALENDAR_WEBHOOK_URL) {
        const { startWebhookRenewalTimer } = await import('./lib/webhookRenewal.js');
        startWebhookRenewalTimer();
    }

    // Outbound webhook delivery worker. In dev/test the worker runs by default so e2e can
    // exercise the full delivery pipeline without manual env-var setup. In production the
    // operator must explicitly opt in via WEBHOOKS_ENABLED=true so a misconfigured deploy can't
    // accidentally start delivering against random URLs.
    const webhooksEnabled = process.env.NODE_ENV !== 'production' || process.env.WEBHOOKS_ENABLED === 'true';
    if (webhooksEnabled) {
        const { startWebhookDeliveryWorker } = await import('./lib/webhookDeliveryWorker.js');
        startWebhookDeliveryWorker();
        console.log('[webhooks] delivery worker started');
    }

    const port = Number(process.env.PORT ?? 4000);
    console.log(`Starting server — commit ${COMMIT_HASH}`);
    serve({ fetch: app.fetch, port }, () => console.log(`Listening on port ${port}`));
}

start();
