import { getCookie } from 'hono/cookie'
import jwt from 'jsonwebtoken'
import type { MiddlewareHandler } from 'hono'
import type { AuthVariables, JwtUsersPayload } from '../types/authTypes.js'
import { authConfig } from '../config.js'
import { ACCESS_TOKEN_COOKIE } from './constants.js'

export const authenticateRequest: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    const token = getCookie(c, ACCESS_TOKEN_COOKIE)
    if (!token) {
        return c.json({ error: 'Unauthorized: No token provided' }, 401)
    }

    try {
        const payload = jwt.verify(token, authConfig.jwtSecret) as JwtUsersPayload
        c.set('users', payload)
        await next()
        return // noImplicitReturns requires explicit return after next()
    } catch {
        return c.json({ error: 'Invalid token' }, 403)
    }
}
