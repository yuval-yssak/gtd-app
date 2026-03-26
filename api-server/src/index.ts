import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { clientUrl } from './config.js';
import { auth, loadDataAccess } from './loaders/mainLoader.js';
import { itemsRoutes } from './routes/items.js';

const app = new Hono()
    .use(
        cors({
            // Allow all origins in dev; restrict to clientUrl in production
            origin: (origin) => (process.env.NODE_ENV !== 'production' ? origin : origin === clientUrl ? origin : null),
            credentials: true, // required so browsers send cookies cross-origin
            allowHeaders: ['Content-Type'],
            allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        }),
    )
    // auth is a live ESM binding — assigned in loadDataAccess() before serve() is called, so it's safe to reference lazily here
    .on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw))
    .route('/items', itemsRoutes);

// Exported for Hono RPC — client imports this type to get a fully-typed fetch client
export type AppType = typeof app;

async function start() {
    await loadDataAccess();
    const port = Number(process.env.PORT ?? 4000);
    serve({ fetch: app.fetch, port }, () => console.log(`Listening on port ${port}`));
}

start();
