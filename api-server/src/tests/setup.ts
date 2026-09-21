import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { afterAll, beforeAll, beforeEach, expect, vi } from 'vitest';

// Every file gets its own MongoDB database (see mainLoader.namespaceTestDB): a short hash of the
// file path keeps the name under Mongo's 63-byte limit. Stamped in beforeAll — registered here, so it
// runs before the file's own beforeAll calls loadDataAccess().
beforeAll(() => {
    const testPath = expect.getState().testPath ?? 'unknown';
    process.env.TEST_FILE_ID = createHash('sha1').update(testPath).digest('hex').slice(0, 8);
});

// Silence incidental console.* from production code during tests.
// If a test has installed its own spy (e.g. vi.spyOn(console, 'warn')),
// isMockFunction is already true and we leave it alone — preserving tests
// that assert on console output (e.g. calendarIntegrationsDAO.updateTokens).
beforeEach(() => {
    if (!vi.isMockFunction(console.log)) vi.spyOn(console, 'log').mockImplementation(() => {});
    if (!vi.isMockFunction(console.info)) vi.spyOn(console, 'info').mockImplementation(() => {});
    if (!vi.isMockFunction(console.debug)) vi.spyOn(console, 'debug').mockImplementation(() => {});
    if (!vi.isMockFunction(console.warn)) vi.spyOn(console, 'warn').mockImplementation(() => {});
    if (!vi.isMockFunction(console.error)) vi.spyOn(console, 'error').mockImplementation(() => {});
});

// The 'shared' vitest project reuses worker processes across files (vitest.config.ts). Clearing the
// module registry once a file is done makes the next file re-evaluate every src/ module — fresh DAO
// singletons, empty in-memory maps, no timers from the previous file — while node_modules stay
// warm in Node's own cache, which is where the per-file import cost was. afterAll, not beforeAll:
// a file's own dynamic `import()`s must keep resolving to the instances its static imports bound.
afterAll(() => {
    vi.resetModules();
});

// Webhook registration is opt-in per test (the webhook-lifecycle tests set CALENDAR_WEBHOOK_URL
// themselves and delete it afterwards). A developer `.env` that sets it leaks into every sync test:
// renewWebhookIfExpired then calls the REAL Google OAuth token endpoint with the fixture's fake
// refresh token — a ~270 ms network round trip per sync that ends in `invalid_grant` (swallowed, but
// it also fires the auth-escalation side effect). Strip it once so the suite is offline and fast.
delete process.env.CALENDAR_WEBHOOK_URL;

// The api-server suite is hermetic: nothing may leave the process over HTTP. googleapis (via
// gaxios → node-fetch v3) and web-push both go through the core `http`/`https` request functions, so
// an unmocked provider call is aborted here, immediately and loudly, instead of making a real round
// trip (a full sync with a linked routine used to reach Google's token endpoint through the
// split-chain heal's getEvent — ~300 ms per test, ending in a swallowed `invalid_grant`).
// It must be an `AbortError` DOMException: gaxios retries any other transport failure with backoff
// (2 extra attempts, ~500 ms) but never retries an aborted request. Better Auth's OAuth exchange and
// the Anthropic SDK use the global `fetch` (undici), which is unaffected; helpers.ts stubs those
// explicitly. Plain property assignment (not vi.spyOn) so a test file's `vi.restoreAllMocks()`
// cannot lift the guard.
const abortOutboundRequest = (protocol: string) => () => {
    throw new DOMException(
        `[tests] outbound ${protocol} request aborted — the suite is offline; mock the GoogleCalendarProvider method (or the library call) that made it`,
        'AbortError',
    );
};
http.request = abortOutboundRequest('http');
https.request = abortOutboundRequest('https');
