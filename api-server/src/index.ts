import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { clientUrl } from './config.js';
import { loadDataAccess } from './loaders/mainLoader.js';
import { authRoutes } from './routes/auth.js';
import { githubRoutes } from './routes/authGitHub.js';
import { itemsRoutes } from './routes/items.js';

const app = new Hono()
    .use(
        cors({
            // Allow all origins in dev; restrict to clientUrl in production
            // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation here
            origin: (origin) => (process.env['NODE_ENV'] !== 'production' ? origin : origin === clientUrl ? origin : null),
            credentials: true, // required so browsers send cookies cross-origin
            allowHeaders: ['Content-Type'],
            allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        }),
    )
    .route('/auth', authRoutes)
    .route('/auth/github', githubRoutes)
    .route('/items', itemsRoutes);

// Exported for Hono RPC — client imports this type to get a fully-typed fetch client
export type AppType = typeof app;

async function start() {
    await loadDataAccess();
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation here
    const port = Number(process.env['PORT'] ?? 4000);
    serve({ fetch: app.fetch, port }, () => console.log(`Listening on port ${port}`));
}

start();
