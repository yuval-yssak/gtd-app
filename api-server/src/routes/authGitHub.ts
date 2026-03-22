import { Hono } from 'hono';
import { issueRefreshToken, setAuthCookies, signAccessToken, upsertUserByEmail } from '../auth/oauthProvider.js';
import { clientUrl, githubOAuthConfig } from '../config.js';

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails';

type GitHubTokenType = {
    access_token: string;
    scope: string;
    token_type: string;
    // GitHub OAuth app tokens do not expire by default (no expires_in field)
};

type GitHubUserType = {
    id: number;
    login: string;
    name: string | null;
    email: string | null; // null when user has set email to private
    avatar_url: string;
};

type GitHubEmailEntry = {
    email: string;
    primary: boolean;
    verified: boolean;
    visibility: string | null;
};

async function exchangeCodeForToken(code: string): Promise<GitHubTokenType> {
    const response = await fetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
            client_id: githubOAuthConfig.clientID,
            client_secret: githubOAuthConfig.clientSecret,
            redirect_uri: githubOAuthConfig.redirectUri,
            code,
        }),
    });
    if (!response.ok) throw new Error(`GitHub token exchange failed: ${response.status}`);
    const data: unknown = await response.json();
    return data as GitHubTokenType;
}

async function fetchUserProfile(accessToken: string): Promise<GitHubUserType> {
    const response = await fetch(GITHUB_USER_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`GitHub user fetch failed: ${response.status}`);
    const data: unknown = await response.json();
    return data as GitHubUserType;
}

/** GitHub users can hide their email; fall back to the /user/emails endpoint to find the primary verified one. */
async function fetchPrimaryEmail(accessToken: string): Promise<string> {
    const response = await fetch(GITHUB_EMAILS_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`GitHub emails fetch failed: ${response.status}`);
    const emails = (await response.json()) as GitHubEmailEntry[];
    const primary = emails.find((e) => e.primary && e.verified);
    if (!primary) throw new Error('No primary verified email found in GitHub account');
    return primary.email;
}

export const githubRoutes = new Hono()
    .get('/', (c) => {
        const url = new URL('https://github.com/login/oauth/authorize');
        url.search = new URLSearchParams({
            client_id: githubOAuthConfig.clientID,
            redirect_uri: githubOAuthConfig.redirectUri,
            scope: 'user:email', // user:email grants access to private emails via /user/emails
        }).toString();
        return c.redirect(url.href);
    })
    .get('/callback', async (c) => {
        const code = c.req.query('code');
        if (!code) return c.json({ error: 'Missing authorization code' }, 400);

        try {
            const githubToken = await exchangeCodeForToken(code);
            const githubUser = await fetchUserProfile(githubToken.access_token);

            // Prefer the email on the user object; fall back to the emails API if hidden
            const email = githubUser.email ?? (await fetchPrimaryEmail(githubToken.access_token));

            // Split display name into first/last (best-effort; GitHub name is a single string)
            const [firstName = githubUser.login, ...rest] = (githubUser.name ?? githubUser.login).split(' ');
            const lastName = rest.join(' ');

            const userId = await upsertUserByEmail(
                { email, firstName, lastName, picture: githubUser.avatar_url },
                { provider: 'github', accessToken: githubToken.access_token, expiresIn: 0 },
            );

            const accessToken = signAccessToken(userId.toString(), email);
            const refreshToken = await issueRefreshToken(userId, email);
            setAuthCookies(c, accessToken, refreshToken);
            return c.redirect(clientUrl);
        } catch (error) {
            console.error('GitHub OAuth callback error:', error instanceof Error ? error.message : error);
            return c.json({ error: 'Authentication failed' }, 500);
        }
    });
