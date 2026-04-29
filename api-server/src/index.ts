import { execSync } from 'node:child_process';
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { clientUrl } from './config.js';
import { auth, loadDataAccess } from './loaders/mainLoader.js';
import { calendarRoutes } from './routes/calendar.js';
import { deviceRoutes } from './routes/devices.js';
import { pushRoutes } from './routes/push.js';
import { syncRoutes } from './routes/sync.js';

function resolveCommitHash() {
    try {
        return execSync('git rev-parse --short HEAD').toString().trim();
    } catch {
        return 'unknown';
    }
}

const COMMIT_HASH = process.env.COMMIT_HASH ?? resolveCommitHash();

const app = new Hono()
    .use(
        cors({
            // Allow all origins in dev; restrict to clientUrl in production
            origin: (origin) => (process.env.NODE_ENV !== 'production' ? origin : origin === clientUrl ? origin : null),
            credentials: true, // required so browsers send cookies cross-origin
            // X-Device-Id lets the auth middleware track which devices host which accounts
            allowHeaders: ['Content-Type', 'X-Device-Id'],
            // PATCH needed for partial updates (e.g., calendar sync config)
            allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        }),
    )
    // auth is a live ESM binding — assigned in loadDataAccess() before serve() is called, so it's safe to reference lazily here
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .route('/sync', syncRoutes)
    .route('/push', pushRoutes)
    .route('/devices', deviceRoutes)
    .route('/calendar', calendarRoutes)
    .get('/version', (c) => c.json({ commitHash: COMMIT_HASH }));

// Exported for Hono RPC — client imports this type to get a fully-typed fetch client
export type AppType = typeof app;

async function start() {
    await loadDataAccess();

    // Dynamic import so the module (and its production guard) is never evaluated in production.
    if (process.env.NODE_ENV !== 'production') {
        const { devLoginRoutes } = await import('./routes/devLogin.js');
        app.route('/dev', devLoginRoutes);
    }

    // Keep Google Calendar webhook channels alive without Cloud Scheduler.
    if (process.env.CALENDAR_WEBHOOK_URL) {
        const { startWebhookRenewalTimer } = await import('./lib/webhookRenewal.js');
        startWebhookRenewalTimer();
    }

    const port = Number(process.env.PORT ?? 4000);
    console.log(`Starting server — commit ${COMMIT_HASH}`);
    serve({ fetch: app.fetch, port }, () => console.log(`Listening on port ${port}`));
}

start();
