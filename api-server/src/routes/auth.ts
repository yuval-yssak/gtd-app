import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import dayjs from 'dayjs'
import { ObjectId } from 'mongodb'
import type { Context } from 'hono'
import type { UsersPayload, AuthVariables } from '../types/authTypes.js'
import usersDAO from '../dataAccess/usersDAO.js'
import refreshTokensDAO from '../dataAccess/refreshTokensDAO.js'
import { authConfig, googleOAuthConfig, clientUrl } from '../config.js'
import { authenticateRequest } from '../auth/middleware.js'
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '../auth/constants.js'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USER_INFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'

type GoogleTokenType = {
    access_token: string
    expires_in: number
    refresh_token?: string // not always returned; only on first consent grant
    scope: string
    token_type: 'Bearer'
}

type GoogleUserInfoType = {
    id: string
    email: string
    verified_email: boolean
    name: string
    given_name: string
    family_name: string
    picture: string
}

function setAuthCookies(c: Context, accessTokenValue: string, refreshTokenValue: string) {
    if (process.env['NODE_ENV'] === 'production') {
        // sameSite: 'None' + secure required when client (Cloudflare Pages) and API (Cloud Run) are on different domains
        setCookie(c, ACCESS_TOKEN_COOKIE, accessTokenValue, { httpOnly: true, secure: true, sameSite: 'None', path: '/', maxAge: 15 * 60 })
        setCookie(c, REFRESH_TOKEN_COOKIE, refreshTokenValue, { httpOnly: true, secure: true, sameSite: 'None', path: '/', maxAge: 30 * 24 * 60 * 60 })
    } else {
        setCookie(c, ACCESS_TOKEN_COOKIE, accessTokenValue, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 15 * 60 })
        setCookie(c, REFRESH_TOKEN_COOKIE, refreshTokenValue, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 30 * 24 * 60 * 60 })
    }
}

async function exchangeCodeForToken(code: string): Promise<GoogleTokenType> {
    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            code,
            client_id: googleOAuthConfig.clientID,
            client_secret: googleOAuthConfig.clientSecret,
            redirect_uri: googleOAuthConfig.redirectUri,
            grant_type: 'authorization_code',
        }),
    })
    if (!response.ok) throw new Error(`Google token exchange failed: ${response.status}`)
    const data: unknown = await response.json()
    return data as GoogleTokenType
}

async function fetchUserProfile(accessToken: string): Promise<GoogleUserInfoType> {
    const response = await fetch(GOOGLE_USER_INFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!response.ok) throw new Error(`Google user info fetch failed: ${response.status}`)
    const data: unknown = await response.json()
    return data as GoogleUserInfoType
}

async function saveUserAndToken(user: GoogleUserInfoType, token: GoogleTokenType): Promise<ObjectId> {
    const now = dayjs().toISOString()

    const result = await usersDAO.collection.findOneAndUpdate(
        { email: user.email },
        {
            $setOnInsert: { email: user.email, createdTs: now },
            $set: { updatedTs: now, firstName: user.given_name, lastName: user.family_name, picture: user.picture },
        },
        { upsert: true, returnDocument: 'after' },
    )

    // Replace Google token entry in the user doc (pull old, push fresh)
    await usersDAO.updateOne({ email: user.email }, { $pull: { tokens: { provider: 'google' } } })
    await usersDAO.updateOne(
        { email: user.email },
        {
            $push: {
                tokens: {
                    provider: 'google',
                    accessToken: token.access_token,
                    refreshToken: token.refresh_token ?? '',
                    expireTs: dayjs().add(token.expires_in, 'seconds').toISOString(),
                },
            },
        },
    )

    if (!result?._id) throw new Error(`Could not upsert user ${user.email}`)
    return result._id
}

async function issueRefreshToken(userId: ObjectId, email: string): Promise<string> {
    const token = randomUUID()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
    await refreshTokensDAO.insertOne({ token, userId, email, expiresAt, createdAt: now })
    return token
}

function signAccessToken(userId: string, email: string): string {
    const payload: UsersPayload = { contents: [{ id: userId, email }] }
    return jwt.sign(payload, authConfig.jwtSecret, { expiresIn: '15m' })
}

const googleRoutes = new Hono()
    .get('/', (c) => {
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
        url.search = new URLSearchParams({
            client_id: googleOAuthConfig.clientID,
            redirect_uri: googleOAuthConfig.redirectUri,
            response_type: 'code',
            access_type: 'offline',
            prompt: 'consent', // force Google to always return a refresh_token
            scope: 'openid email profile',
        }).toString()
        return c.redirect(url.href)
    })
    .get('/callback', async (c) => {
        const code = c.req.query('code')
        if (!code) return c.json({ error: 'Missing authorization code' }, 400)

        try {
            const googleToken = await exchangeCodeForToken(code)
            const user = await fetchUserProfile(googleToken.access_token)
            const userId = await saveUserAndToken(user, googleToken)
            const accessToken = signAccessToken(userId.toString(), user.email)
            const refreshToken = await issueRefreshToken(userId, user.email)
            setAuthCookies(c, accessToken, refreshToken)
            return c.redirect(clientUrl)
        } catch (error) {
            console.error('Google OAuth callback error:', error instanceof Error ? error.message : error)
            return c.json({ error: 'Authentication failed' }, 500)
        }
    })

export const authRoutes = new Hono<{ Variables: AuthVariables }>()
    .route('/google', googleRoutes)
    .get('/check', authenticateRequest, (c) => {
        return c.json(c.get('users'))
    })
    .post('/refresh', async (c) => {
        const refreshTokenValue = getCookie(c, REFRESH_TOKEN_COOKIE)
        if (!refreshTokenValue) return c.json({ error: 'No refresh token' }, 401)

        const docs = await refreshTokensDAO.findArray({ token: refreshTokenValue })
        const doc = docs[0]
        if (!doc) return c.json({ error: 'Invalid or expired refresh token' }, 401)

        // Rotate: delete old token, issue new one — limits damage from stolen refresh tokens
        await refreshTokensDAO.collection.deleteOne({ token: refreshTokenValue })
        const newRefreshToken = await issueRefreshToken(doc.userId, doc.email)
        const accessToken = signAccessToken(doc.userId.toString(), doc.email)
        setAuthCookies(c, accessToken, newRefreshToken)
        return c.json({ ok: true })
    })
    .post('/sign-out', async (c) => {
        const refreshTokenValue = getCookie(c, REFRESH_TOKEN_COOKIE)
        if (refreshTokenValue) {
            await refreshTokensDAO.collection.deleteOne({ token: refreshTokenValue })
        }
        deleteCookie(c, ACCESS_TOKEN_COOKIE, { path: '/' })
        deleteCookie(c, REFRESH_TOKEN_COOKIE, { path: '/' })
        return c.json({ ok: true })
    })
    .post('/sign-out-all', async (c) => {
        const refreshTokenValue = getCookie(c, REFRESH_TOKEN_COOKIE)
        if (refreshTokenValue) {
            const docs = await refreshTokensDAO.findArray({ token: refreshTokenValue })
            const doc = docs[0]
            if (doc) {
                // Delete all sessions for this user across all devices
                await refreshTokensDAO.collection.deleteMany({ userId: doc.userId })
            }
        }
        deleteCookie(c, ACCESS_TOKEN_COOKIE, { path: '/' })
        deleteCookie(c, REFRESH_TOKEN_COOKIE, { path: '/' })
        return c.json({ ok: true })
    })
