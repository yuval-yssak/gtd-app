/**
 * Environment classification + web-app origin derivation for the REMOTE MCP server.
 *
 * Adapted from mcp-server/src/config.ts — keeps `GtdEnvironment`, `classifyEnvironment`, and
 * `resolveWebBase` (the deep-link origin map) but drops the env-var token-map loading, which is a
 * local-stdio concept. Remotely these are derived per request from the api-server's own base URL
 * (the `MCP_OAUTH_ISSUER` origin), not from `GTD_API_BASE`/`GTD_WEB_BASE`.
 */

/**
 * Coarse classification of `apiBase` so the model and operator can tell at a glance which
 * environment a connected MCP server points at. Matches the URL table in the repo's CLAUDE.md.
 * `'custom'` covers self-hosted, preview, or unrecognised hosts.
 */
export type GtdEnvironment = 'local' | 'staging' | 'production' | 'custom';

/**
 * Maps a normalised `apiBase` URL to a coarse environment bucket. `apiBase` should already have
 * trailing slashes stripped.
 */
export function classifyEnvironment(apiBase: string): GtdEnvironment {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(apiBase)) return 'local';
    if (apiBase === 'https://api-staging.getting-things-done.app') return 'staging';
    if (apiBase === 'https://api.getting-things-done.app') return 'production';
    return 'custom';
}

/**
 * Maps an environment bucket to the browsable web-app origin, mirroring the URL table in the
 * repo's CLAUDE.md. Trailing slashes are stripped so callers can append `/item/<id>` directly.
 * `null` for `'custom'` — the web host can't be derived from an unrecognised API host.
 */
export function resolveWebBase(environment: GtdEnvironment): string | null {
    const byEnvironment: Record<GtdEnvironment, string | null> = {
        local: 'http://localhost:4173',
        staging: 'https://staging.getting-things-done.app',
        production: 'https://getting-things-done.app',
        custom: null,
    };
    return byEnvironment[environment];
}
