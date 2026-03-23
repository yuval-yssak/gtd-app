import type { MiddlewareHandler } from 'hono';
import { auth } from '../loaders/mainLoader.js';
import type { AuthVariables } from '../types/authTypes.js';

export const authenticateRequest: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
        return c.json({ error: 'Unauthorized: No session' }, 401);
    }

    c.set('session', session);
    await next();
    return; // noImplicitReturns requires explicit return after next()
};
