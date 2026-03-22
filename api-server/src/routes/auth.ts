import { Hono } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '../auth/constants.js';
import { authenticateRequest } from '../auth/middleware.js';
import { issueRefreshToken, setAuthCookies, signAccessToken, upsertUserByEmail } from '../auth/oauthProvider.js';
import { clientUrl, googleOAuthConfig } from '../config.js';
import refreshTokensDAO from '../dataAccess/refreshTokensDAO.js';
import type { AuthVariables } from '../types/authTypes.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USER_INFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

type GoogleTokenType = {
    access_token: string;
    expires_in: number;
    refresh_token?: string; // not always returned; only on first consent grant
    scope: string;
    token_type: 'Bearer';
};

type GoogleUserInfoType = {
    id: string;
    email: string;
    verified_email: boolean;
    name: string;
    given_name: string;
    family_name: string;
    picture: string;
};

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
    });
    if (!response.ok) throw new Error(`Google token exchange failed: ${response.status}`);
    const data: unknown = await response.json();
    return data as GoogleTokenType;
}

async function fetchUserProfile(accessToken: string): Promise<GoogleUserInfoType> {
    const response = await fetch(GOOGLE_USER_INFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`Google user info fetch failed: ${response.status}`);
    const data: unknown = await response.json();
    return data as GoogleUserInfoType;
}

const googleRoutes = new Hono()
    .get('/', (c) => {
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.search = new URLSearchParams({
            client_id: googleOAuthConfig.clientID,
            redirect_uri: googleOAuthConfig.redirectUri,
            response_type: 'code',
            access_type: 'offline',
            prompt: 'consent', // force Google to always return a refresh_token
            scope: 'openid email profile',
        }).toString();
        return c.redirect(url.href);
    })
    .get('/callback', async (c) => {
        const code = c.req.query('code');
        if (!code) return c.json({ error: 'Missing authorization code' }, 400);

        try {
            const googleToken = await exchangeCodeForToken(code);
            const user = await fetchUserProfile(googleToken.access_token);
            const userId = await upsertUserByEmail(
                { email: user.email, firstName: user.given_name, lastName: user.family_name, picture: user.picture },
                // Conditional spread: exactOptionalPropertyTypes=true forbids passing undefined for an optional key
                {
                    provider: 'google',
                    accessToken: googleToken.access_token,
                    ...(googleToken.refresh_token ? { refreshToken: googleToken.refresh_token } : {}),
                    expiresIn: googleToken.expires_in,
                },
            );
            const accessToken = signAccessToken(userId.toString(), user.email);
            const refreshToken = await issueRefreshToken(userId, user.email);
            setAuthCookies(c, accessToken, refreshToken);
            return c.redirect(clientUrl);
        } catch (error) {
            console.error('Google OAuth callback error:', error instanceof Error ? error.message : error);
            return c.json({ error: 'Authentication failed' }, 500);
        }
    });

export const authRoutes = new Hono<{ Variables: AuthVariables }>()
    .route('/google', googleRoutes)
    .get('/check', authenticateRequest, (c) => {
        return c.json(c.get('users'));
    })
    .post('/refresh', async (c) => {
        const refreshTokenValue = getCookie(c, REFRESH_TOKEN_COOKIE);
        if (!refreshTokenValue) return c.json({ error: 'No refresh token' }, 401);

        const docs = await refreshTokensDAO.findArray({ token: refreshTokenValue });
        const doc = docs[0];
        if (!doc) return c.json({ error: 'Invalid or expired refresh token' }, 401);

        // Rotate: delete old token, issue new one — limits damage from stolen refresh tokens
        await refreshTokensDAO.collection.deleteOne({ token: refreshTokenValue });
        const newRefreshToken = await issueRefreshToken(doc.userId, doc.email);
        const accessToken = signAccessToken(doc.userId.toString(), doc.email);
        setAuthCookies(c, accessToken, newRefreshToken);
        return c.json({ ok: true });
    })
    .post('/sign-out', async (c) => {
        const refreshTokenValue = getCookie(c, REFRESH_TOKEN_COOKIE);
        if (refreshTokenValue) {
            await refreshTokensDAO.collection.deleteOne({ token: refreshTokenValue });
        }
        deleteCookie(c, ACCESS_TOKEN_COOKIE, { path: '/' });
        deleteCookie(c, REFRESH_TOKEN_COOKIE, { path: '/' });
        return c.json({ ok: true });
    })
    .post('/sign-out-all', async (c) => {
        const refreshTokenValue = getCookie(c, REFRESH_TOKEN_COOKIE);
        if (refreshTokenValue) {
            const docs = await refreshTokensDAO.findArray({ token: refreshTokenValue });
            const doc = docs[0];
            if (doc) {
                // Delete all sessions for this user across all devices
                await refreshTokensDAO.collection.deleteMany({ userId: doc.userId });
            }
        }
        deleteCookie(c, ACCESS_TOKEN_COOKIE, { path: '/' });
        deleteCookie(c, REFRESH_TOKEN_COOKIE, { path: '/' });
        return c.json({ ok: true });
    });
