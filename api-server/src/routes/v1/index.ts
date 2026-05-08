import { Hono } from 'hono';
import type { BearerVariables } from '../../auth/bearerMiddleware.js';
import { v1ItemsRoutes } from './items.js';
import { v1PeopleRoutes } from './people.js';
import { v1RoutinesRoutes } from './routines.js';
import { v1WorkContextsRoutes } from './workContexts.js';

/**
 * Composes all `/v1/*` sub-routers into one Hono router. Each sub-router applies its own
 * `authenticateBearer` + `authenticatedRateLimit` middleware, so mounting them all at `/`
 * preserves the per-route path layout (`/items`, `/people`, `/work-contexts`, `/routines`, …)
 * while keeping each entity's handlers and middleware self-contained in its own file.
 */
export const v1Routes = new Hono<{ Variables: BearerVariables }>()
    .route('/', v1ItemsRoutes)
    .route('/', v1PeopleRoutes)
    .route('/', v1WorkContextsRoutes)
    .route('/', v1RoutinesRoutes);
