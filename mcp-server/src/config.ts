/**
 * Reads MCP server config from environment. Tokens come from the user's MCP client config
 * (Claude Desktop, Claude Code, etc.) — never persisted by this server. Mint a token at
 * /settings/api-tokens in the GTD app and paste it into the `env` block of the mcpServers
 * config snippet (see README).
 *
 * **Multi-account.** A single Claude session can drive multiple accounts: the default account's
 * token comes from `GTD_API_TOKEN`, additional accounts are configured as `GTD_API_TOKEN_<LABEL>`
 * (label is normalised to lowercase). All tools accept an optional `account` arg that selects
 * which token to attach; `gtd_reassign` accepts both `fromAccount` and `toAccount` so the MCP
 * can assemble the new two-token consent gesture without leaking raw tokens to the model.
 */

const NUMBERED_TOKEN_ENV_PATTERN = /^GTD_API_TOKEN_(.+)$/;
const DEFAULT_ACCOUNT_LABEL = 'default';

/**
 * Coarse classification of `apiBase` so the model and operator can tell at a glance which
 * environment a connected MCP server points at. Matches the URL table in the repo's CLAUDE.md.
 * `'custom'` covers self-hosted, preview, or unrecognised hosts — the operator owns that case.
 */
export type GtdEnvironment = 'local' | 'staging' | 'production' | 'custom';

export interface McpConfig {
    apiBase: string;
    environment: GtdEnvironment;
    /**
     * Base URL of the browsable web app for this environment (distinct from `apiBase`, which is
     * the backend). Used to stamp a per-entity deep link onto tool responses so every Claude
     * session surfaces a clickable item/routine link without relying on any user's local memory.
     * `null` for `'custom'` environments, where the web host can't be derived from the API host;
     * an operator can pin it explicitly via `GTD_WEB_BASE`.
     */
    webBase: string | null;
    /** Map keyed by lowercase account label. `'default'` is reserved for `GTD_API_TOKEN`. */
    tokens: Map<string, string>;
}

export function loadConfig(): McpConfig {
    const apiBase = (process.env.GTD_API_BASE ?? 'http://localhost:4000').replace(/\/+$/, '');
    const environment = classifyEnvironment(apiBase);
    return { apiBase, environment, webBase: resolveWebBase(environment, process.env.GTD_WEB_BASE), tokens: collectTokensFromEnv(process.env) };
}

/**
 * Maps an environment bucket to the browsable web-app origin, mirroring the URL table in the
 * repo's CLAUDE.md. An explicit `GTD_WEB_BASE` override wins for every environment — it's the
 * only way to give `'custom'` (self-hosted/preview) deployments a working deep link. Trailing
 * slashes are stripped so callers can append `/item/<id>` directly.
 */
export function resolveWebBase(environment: GtdEnvironment, override?: string): string | null {
    if (typeof override === 'string' && override.length > 0) {
        return override.replace(/\/+$/, '');
    }
    const byEnvironment: Record<GtdEnvironment, string | null> = {
        local: 'http://localhost:4173',
        staging: 'https://staging.getting-things-done.app',
        production: 'https://getting-things-done.app',
        custom: null,
    };
    return byEnvironment[environment];
}

/**
 * Maps a normalised `apiBase` URL to a coarse environment bucket. Exposed for tests and so
 * downstream code (e.g. tools surfacing `environment` in responses) doesn't have to re-derive
 * it. `loadConfig` strips trailing slashes before calling this — keep that contract in mind if
 * you add a new bucket.
 */
export function classifyEnvironment(apiBase: string): GtdEnvironment {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(apiBase)) return 'local';
    if (apiBase === 'https://api-staging.getting-things-done.app') return 'staging';
    if (apiBase === 'https://api.getting-things-done.app') return 'production';
    return 'custom';
}

/**
 * Walks `env` and collects every account token into one map. Exposed for tests so they can
 * exercise the parsing logic without needing to mutate the live `process.env`.
 */
export function collectTokensFromEnv(env: NodeJS.ProcessEnv): Map<string, string> {
    const tokens = new Map<string, string>();
    addDefaultToken(env, tokens);
    addNumberedTokens(env, tokens);
    if (tokens.size === 0) {
        throw new Error('No GTD API tokens configured. Set GTD_API_TOKEN (and optionally GTD_API_TOKEN_<LABEL>) in your MCP client config.');
    }
    return tokens;
}

function addDefaultToken(env: NodeJS.ProcessEnv, tokens: Map<string, string>): void {
    const value = env.GTD_API_TOKEN;
    if (typeof value !== 'string' || value.length === 0) {
        return;
    }
    tokens.set(DEFAULT_ACCOUNT_LABEL, value);
}

function addNumberedTokens(env: NodeJS.ProcessEnv, tokens: Map<string, string>): void {
    for (const [key, value] of Object.entries(env)) {
        const match = NUMBERED_TOKEN_ENV_PATTERN.exec(key);
        if (!match) {
            continue;
        }
        const label = match[1]?.toLowerCase();
        if (!label) {
            continue;
        }
        if (typeof value !== 'string' || value.length === 0) {
            throw new Error(`Empty value for ${key}. Remove the variable or set a valid token.`);
        }
        if (label === DEFAULT_ACCOUNT_LABEL) {
            throw new Error(`GTD_API_TOKEN_DEFAULT is reserved — use GTD_API_TOKEN for the default account.`);
        }
        tokens.set(label, value);
    }
}
