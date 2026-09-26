import { google } from 'googleapis';

// Typed off `google.options` rather than gaxios' own exports: gaxios ships parallel CJS and ESM
// type trees, and a redactor typed against one is not assignable to the option typed against the other.
type GoogleErrorRedactor = Exclude<NonNullable<NonNullable<Parameters<typeof google.options>[0]>['errorRedactor']>, false>;
type RedactableConfig = NonNullable<Parameters<GoogleErrorRedactor>[0]['config']>;

const REDACTED = '<<redacted>>';
const CREDENTIAL_HEADER = /^authorization$|^authentication$|secret/i;
const CREDENTIAL_PARAMS = ['token', 'client_secret', 'key'];

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
 * the one nested under its response, on top of the credential redaction gaxios would have done.
 */
export const redactGoogleRequestBodies: GoogleErrorRedactor = (data) => {
    for (const config of [data.config, data.response?.config]) {
        if (!config) continue;
        redactCredentials(config);
        redactRequestBody(config);
    }
    redactHeaders(data.response?.headers);
    return data;
};

/**
 * Installs the redactor on the shared `google` client so every `google.calendar()` request made
 * anywhere in the process gets it (googleapis merges these global options into each request).
 * `options()` replaces the whole global set, so what is already there is carried over.
 */
export function installGoogleErrorRedactor() {
    google.options({ ...google._options, errorRedactor: redactGoogleRequestBodies });
}
