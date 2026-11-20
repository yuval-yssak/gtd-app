import { inspect } from 'node:util';
import { google } from 'googleapis';

// Typed off `google.options` rather than gaxios' own exports: gaxios ships parallel CJS and ESM
// type trees, and a redactor typed against one is not assignable to the option typed against the other.
type GoogleErrorRedactor = Exclude<NonNullable<NonNullable<Parameters<typeof google.options>[0]>['errorRedactor']>, false>;
type RedactableConfig = NonNullable<Parameters<GoogleErrorRedactor>[0]['config']>;

const REDACTED = '<<redacted>>';
const CREDENTIAL_HEADER = /^authorization$|^authentication$|secret/i;
const CREDENTIAL_PARAMS = ['token', 'client_secret', 'key'];
// Google addresses a user's primary calendar by their email address: `/calendars/<id>/events/…`.
const CALENDAR_ID_IN_PATH = /(\/calendars\/)[^/]+/;
// No angle brackets: the URL pathname setter would percent-encode them into an unreadable token.
const REDACTED_CALENDAR_ID = 'redacted-calendar-id';
// Backstop for an address echoed anywhere else in the summary, e.g. inside a Google error message.
const EMAIL_ADDRESS = /[\w.%+-]+(?:@|%40)[\w-]+(?:\.[\w-]+)+/gi;

/**
 * Best effort on the response side: a native fetch `Response` (undici) exposes immutable headers,
 * and `set` throws on them — node-fetch, gaxios' default in Node and therefore what production
 * runs, has mutable ones, and the request-side `Headers` gaxios prepares are always mutable. The
 * redactor runs unguarded in gaxios' catch block, so a throw here would replace the GaxiosError
 * with a TypeError and lose the status the callers categorise on.
 */
function redactHeaders(headers: Headers | undefined) {
    headers?.forEach((_, key) => {
        if (!CREDENTIAL_HEADER.test(key)) return;
        try {
            headers.set(key, REDACTED);
        } catch {
            // immutable response headers — nothing to do, the request side is what carried credentials
        }
    });
}

/**
 * What gaxios' own `defaultErrorRedactor` strips (plus the `key` API-key param). Mirrored here
 * because setting `errorRedactor` replaces the default outright, and the package's `exports` map
 * hides the default from importers.
 */
function redactCredentials(config: RedactableConfig) {
    redactHeaders(config.headers);
    for (const param of CREDENTIAL_PARAMS) {
        if (config.url.searchParams.has(param)) config.url.searchParams.set(param, REDACTED);
        if (config.params && param in config.params) config.params[param] = REDACTED;
    }
}

/** A fresh URL rather than an in-place edit: the error's deep-copied config still shares the request's URL instance. */
function redactCalendarId(config: RedactableConfig) {
    if (!(config.url instanceof URL)) return;
    const redacted = new URL(config.url);
    redacted.pathname = config.url.pathname.replace(CALENDAR_ID_IN_PATH, `$1${REDACTED_CALENDAR_ID}`);
    config.url = redacted;
}

/** The event body (`summary`, `description`, attendee emails) rides on `data`/`body` of a failed request. */
function redactRequestBody(config: RedactableConfig) {
    if (config.data !== undefined) config.data = REDACTED;
    if (config.body !== undefined) config.body = REDACTED;
}

/**
 * A `GaxiosError` keeps the request it was thrown for, and the default redactor only blanks
 * credentials — so `console.error('…', err)` on a failed `events.insert`/`patch` prints the event
 * title, description and attendee addresses into Cloud Logging. The privacy policy promises logs
 * never carry that text, so this drops the request body from both the error's own config and
 * the one nested under its response, on top of the credential redaction gaxios would have done,
 * takes the calendar id (an email address) out of the request URL, and makes the error log as a
 * short summary instead of a full object dump (see `logAsSummary`).
 */
export const redactGoogleRequestBodies: GoogleErrorRedactor = (data) => {
    for (const config of [data.config, data.response?.config]) {
        if (!config) continue;
        redactCredentials(config);
        redactRequestBody(config);
        redactCalendarId(config);
    }
    redactHeaders(data.response?.headers);
    if (data instanceof Error) logAsSummary(data);
    return data;
};

interface GoogleErrorDetail {
    domain?: unknown;
    reason?: unknown;
    message?: unknown;
}

/** Google's per-error reasons (`errors[]`), which gaxios parks on the error's `cause`. Never throws: it runs inside the redactor. */
function googleErrorDetails(error: Error): GoogleErrorDetail[] {
    const { cause } = error;
    if (typeof cause !== 'object' || cause === null || !('errors' in cause) || !Array.isArray(cause.errors)) return [];
    return cause.errors
        .filter((detail): detail is GoogleErrorDetail => typeof detail === 'object' && detail !== null)
        .map(({ domain, reason, message }) => ({ domain, reason, message }));
}

/** A network failure has no response; its underlying error (e.g. `ECONNRESET`) is the only clue. */
function causeLine(error: Error) {
    const { cause } = error;
    if (!(cause instanceof Error)) return undefined;
    const code = 'code' in cause ? ` (${String(cause.code)})` : '';
    const inner = cause.cause instanceof Error ? ` <- ${cause.cause.message}` : '';
    return `${cause.name}: ${cause.message}${code}${inner}`;
}

type RedactedGoogleError = Error & Parameters<GoogleErrorRedactor>[0];

function errorSummary(error: RedactedGoogleError) {
    return {
        status: error.response?.status,
        code: 'code' in error ? error.code : undefined,
        method: error.config?.method,
        path: error.config?.url instanceof URL ? error.config.url.pathname : undefined,
        errors: googleErrorDetails(error),
        cause: causeLine(error),
    };
}

/**
 * `console.error('…', err)` renders a GaxiosError as ~120 lines of request config, response
 * internals and the request URL (with the calendar id) — while Google's reason, the one fact
 * needed to diagnose a failure, sits beyond console's inspect depth as `errors: [ [Object] ]`.
 * Replacing the inspect rendering keeps the stack and adds a summary carrying only the status,
 * method, redacted path and Google's reasons. Only rendering changes: the properties the
 * categorisers read stay on the error.
 */
function logAsSummary(error: RedactedGoogleError) {
    const summary = errorSummary(error);
    Object.defineProperty(error, inspect.custom, {
        configurable: true,
        value: () =>
            `${error.stack ?? error.message} ${inspect(summary, { depth: 4, breakLength: Number.POSITIVE_INFINITY })}`.replace(
                EMAIL_ADDRESS,
                '<<redacted email>>',
            ),
    });
}

/**
 * Installs the redactor on the shared `google` client so every `google.calendar()` request made
 * anywhere in the process gets it (googleapis merges these global options into each request).
 * `options()` replaces the whole global set, so what is already there is carried over.
 */
export function installGoogleErrorRedactor() {
    google.options({ ...google._options, errorRedactor: redactGoogleRequestBodies });
}
