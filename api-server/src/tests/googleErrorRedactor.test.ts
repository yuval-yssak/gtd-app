/** lib/googleErrorRedactor: a failed Google Calendar request must not leave the event body on the
 * thrown error, because the pushback paths `console.error` the whole error into Cloud Logging.
 * The request really goes out — to a local server answering 403 — through a real `google.calendar`
 * client, so this covers googleapis' option merging and gaxios' constructor-time redaction, not just
 * the redactor function in isolation. Native fetch is passed in explicitly: gaxios defaults to
 * node-fetch, which goes through `http.request`, and tests/setup.ts aborts that for the whole suite.
 *
 * `util.inspect` does not render the own properties gaxios adds to the native `Response`, so the
 * nested `response.config` is asserted on directly — a structured logger would serialise it. */
import { type AddressInfo, createServer, type Server } from 'node:http';
import { inspect } from 'node:util';
import dayjs from 'dayjs';
import { GaxiosError } from 'gaxios';
import { google } from 'googleapis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installGoogleErrorRedactor } from '../lib/googleErrorRedactor.js';

const SECRET_TITLE = 'SECRET TITLE 7d1e';
const SECRET_NOTES = 'SECRET NOTES 9c4a';
const SECRET_ATTENDEE = 'secret-attendee@example.com';
const SECRET_ACCESS_TOKEN = 'ya29.secret-access-token-3f2b';
const SECRET_RESPONSE_HEADER = 'response-secret-5e1c';
const REDACTED = '<<redacted>>';

function listeningRootUrl(server: Server) {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('stub server did not bind a TCP port');
    return `http://127.0.0.1:${(address satisfies AddressInfo).port}/`;
}

/** Every request gets Google's rate-limit shape — the failure the pushback paths hit most. */
function startRateLimitedGoogle() {
    const server = createServer((_req, res) => {
        // A credential-looking response header: native Response headers are immutable, so this proves
        // the redactor's response-side pass never throws (which would swap the GaxiosError for a TypeError).
        res.writeHead(403, { 'content-type': 'application/json', 'x-goog-client-secret': SECRET_RESPONSE_HEADER });
        res.end(JSON.stringify({ error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }));
    });
    return new Promise<Server>((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** A preset, unexpired access token: the production shape (bearer header, no refresh round trip). */
function bearerAuth() {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: SECRET_ACCESS_TOKEN, expiry_date: dayjs().add(1, 'hour').valueOf() });
    return auth;
}

/** Sends an event with secrets in every content field and hands back the error the stub provokes. */
async function failedInsert(rootUrl: string, redactor: 'installed' | 'disabled') {
    // A per-API `errorRedactor: false` overrides the global one so the negative control can show
    // the body would otherwise leak.
    const calendar = google.calendar({
        version: 'v3',
        auth: bearerAuth(),
        rootUrl,
        fetchImplementation: globalThis.fetch,
        ...(redactor === 'disabled' && { errorRedactor: false }),
    });
    const insert = calendar.events.insert({
        calendarId: 'primary',
        requestBody: { summary: SECRET_TITLE, description: SECRET_NOTES, attendees: [{ email: SECRET_ATTENDEE }] },
    });
    const error: unknown = await insert.then(
        () => {
            throw new Error('expected the stub to reject the insert');
        },
        (rejection: unknown) => rejection,
    );
    if (!(error instanceof GaxiosError)) {
        throw new Error('expected a GaxiosError');
    }
    return error;
}

let server: Server;
let rootUrl: string;

beforeAll(async () => {
    server = await startRateLimitedGoogle();
    rootUrl = listeningRootUrl(server);
    installGoogleErrorRedactor();
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('installGoogleErrorRedactor', () => {
    it('strips the event body and the bearer token from a failed request while keeping the status and message', async () => {
        const error = await failedInsert(rootUrl, 'installed');
        const dumped = inspect(error, { depth: 8 });
        expect(dumped).toContain('403');
        expect(dumped).toContain('Rate Limit Exceeded');
        for (const secret of [SECRET_TITLE, SECRET_NOTES, SECRET_ATTENDEE, SECRET_ACCESS_TOKEN]) {
            expect(dumped).not.toContain(secret);
        }
    });

    it('also blanks the request copy nested under the response, which inspect never shows', async () => {
        const error = await failedInsert(rootUrl, 'installed');
        expect(error.response?.config.data).toBe(REDACTED);
        expect(error.response?.config.body).toBe(REDACTED);
        const serialised = JSON.stringify(error.response?.config);
        expect(serialised).not.toContain(SECRET_TITLE);
        expect(serialised).not.toContain(SECRET_ATTENDEE);
        // Immutable on a native Response, so it cannot be blanked — the test above proves the error survives it.
        expect(error.response?.headers.get('x-goog-client-secret')).toBe(SECRET_RESPONSE_HEADER);
    });

    it('carries over global options that were already set', () => {
        google.options({ ...google._options, timeout: 1234 });
        installGoogleErrorRedactor();
        expect(google._options.timeout).toBe(1234);
        expect(google._options.errorRedactor).toBeTypeOf('function');
    });

    it('is what keeps the body out — without a redactor the error carries the title and attendee', async () => {
        const error = await failedInsert(rootUrl, 'disabled');
        const dumped = inspect(error, { depth: 8 });
        expect(dumped).toContain(SECRET_TITLE);
        expect(dumped).toContain(SECRET_ATTENDEE);
        expect(JSON.stringify(error.response?.config)).toContain(SECRET_TITLE);
    });
});
