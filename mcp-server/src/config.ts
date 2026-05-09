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

export interface McpConfig {
    apiBase: string;
    /** Map keyed by lowercase account label. `'default'` is reserved for `GTD_API_TOKEN`. */
    tokens: Map<string, string>;
}

export function loadConfig(): McpConfig {
    const apiBase = (process.env.GTD_API_BASE ?? 'http://localhost:4000').replace(/\/+$/, '');
    return { apiBase, tokens: collectTokensFromEnv(process.env) };
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
