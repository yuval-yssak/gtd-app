/**
 * One-time OAuth setup for the sync audit suite.
 *
 * Runs a local loopback server, opens Google's consent screen, and captures
 * the authorization code. Exchanges the code for a long-lived refresh token
 * and writes it to .secrets/gcal-e2e.json.
 *
 * Usage:
 *   cd api-server
 *   npx tsx src/tests-sync-audit/setupOAuth.ts
 *
 * The resulting refresh token is long-lived (~6 months) and is the only
 * Google-side credential the audit needs. The access token is minted
 * automatically on first API call via googleapis' built-in refresh flow.
 *
 * Prerequisites (add to the Google Cloud OAuth client used by the app):
 *   - Authorized redirect URI: http://localhost:4466/callback
 *   - Scope: https://www.googleapis.com/auth/calendar
 */

import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SECRETS_PATH = resolve(__dirname, '.secrets/gcal-e2e.json');
const LOOPBACK_PORT = 4466;
const REDIRECT_URI = `http://localhost:${LOOPBACK_PORT}/callback`;

interface SecretsFile {
    refreshToken: string;
    calendarId: string;
    email: string;
    obtainedAt: string;
    note: string;
}

function requireEnv(name: 'GOOGLE_OAUTH_APP_CLIENT_ID' | 'GOOGLE_OAUTH_APP_CLIENT_SECRET'): string {
    const v = process.env[name];
    if (!v) {
        throw new Error(`Missing env var ${name} — load from api-server/.env before running this script`);
    }
    return v;
}

function waitForCode(): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
        const server = createServer((req, res) => {
            const url = new URL(req.url ?? '/', `http://localhost:${LOOPBACK_PORT}`);
            if (url.pathname !== '/callback') {
                res.statusCode = 404;
                res.end('Not found');
                return;
            }
            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html');
            if (error) {
                res.end(`<h1>OAuth error: ${error}</h1><p>Close this tab and re-run the script.</p>`);
                server.close();
                rejectPromise(new Error(`OAuth error: ${error}`));
                return;
            }
            if (!code) {
                res.end('<h1>No code in callback</h1>');
                server.close();
                rejectPromise(new Error('Callback missing code parameter'));
                return;
            }
            res.end('<h1>Authorized.</h1><p>You can close this tab.</p>');
            server.close();
            resolvePromise(code);
        });
        server.listen(LOOPBACK_PORT, () => {
            console.log(`Loopback listening on ${REDIRECT_URI}`);
        });
    });
}

async function pickCalendar(oauth2: InstanceType<typeof google.auth.OAuth2>): Promise<{ id: string; summary: string }> {
    const cal = google.calendar({ version: 'v3', auth: oauth2 });
    const list = await cal.calendarList.list();
    const items = (list.data.items ?? []).filter((c): c is typeof c & { id: string; summary: string } => Boolean(c.id && c.summary));
    if (items.length === 0) {
        throw new Error('No calendars visible on this Google account');
    }
    const primary = items.find((c) => c.id === 'primary') ?? items.find((c) => (c as { primary?: boolean }).primary === true);
    const pick = primary ?? items[0];
    if (!pick) {
        throw new Error('No calendars returned');
    }
    console.log(`Using calendar: ${pick.summary} (${pick.id})`);
    return { id: pick.id, summary: pick.summary };
}

async function main(): Promise<void> {
    const clientId = requireEnv('GOOGLE_OAUTH_APP_CLIENT_ID');
    const clientSecret = requireEnv('GOOGLE_OAUTH_APP_CLIENT_SECRET');

    const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
    const authUrl = oauth2.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/calendar', 'email'],
    });

    console.log('\nOpen this URL in your browser and authorize the dedicated test Google account:');
    console.log(`\n  ${authUrl}\n`);
    console.log(`Waiting for redirect to ${REDIRECT_URI}...`);

    const code = await waitForCode();
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
        throw new Error('Google did not return a refresh_token. Revoke app access at https://myaccount.google.com/permissions and re-run.');
    }
    oauth2.setCredentials(tokens);

    const cal = await pickCalendar(oauth2);

    // Fetch email via userinfo so the secrets file records which account was authorized.
    const oauth2Userinfo = google.oauth2({ version: 'v2', auth: oauth2 });
    const userinfo = await oauth2Userinfo.userinfo.get();
    const email = userinfo.data.email ?? 'unknown';

    const secrets: SecretsFile = {
        refreshToken: tokens.refresh_token,
        calendarId: cal.id,
        email,
        obtainedAt: new Date().toISOString(),
        note: 'Used only by src/tests-sync-audit. Gitignored. Revoke at https://myaccount.google.com/permissions.',
    };
    writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2));
    console.log(`\n✓ Wrote ${SECRETS_PATH}`);
    console.log(`  account: ${email}`);
    console.log(`  calendar: ${cal.summary} (${cal.id})`);
}

main().catch((err) => {
    console.error('setupOAuth failed:', err);
    process.exit(1);
});
