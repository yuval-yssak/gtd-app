// Explicit declarations so TypeScript treats these as known properties,
// satisfying noPropertyAccessFromIndexSignature without requiring bracket notation.
declare namespace NodeJS {
    interface ProcessEnv {
        NODE_ENV?: 'development' | 'production' | 'test';
        PORT?: string;
        MONGO_DB_URL?: string;
        MONGO_DB_NAME?: string;
        BETTER_AUTH_URL?: string;
        BETTER_AUTH_SECRET?: string;
        CLIENT_URL?: string;
        GOOGLE_OAUTH_APP_CLIENT_ID?: string;
        GOOGLE_OAUTH_APP_CLIENT_SECRET?: string;
        GITHUB_CLIENT_ID?: string;
        GITHUB_CLIENT_SECRET?: string;
        CALENDAR_ENCRYPTION_KEY?: string;
        CALENDAR_WEBHOOK_URL?: string;
        CALENDAR_WEBHOOK_CRON_SECRET?: string;
        CALENDAR_AUTH_GRACE_MS?: string;
        COMMIT_HASH?: string;
        WEBHOOKS_ENABLED?: string;
        /** Anthropic API key for the Lane A Claude-assist endpoint. Separate billing from any Pro/Max subscription. */
        ANTHROPIC_API_KEY?: string;
        /** HMAC-SHA256 key (hex) for signing/verifying short-lived `executeToken`s. Dev fallback if unset. */
        EXECUTE_TOKEN_SIGNING_KEY?: string;
        /** Per-user daily USD cap for Claude-assist spend. Parsed as a float; falls back to a built-in default. */
        CLAUDE_ASSIST_DAILY_COST_CAP_USD?: string;
        /**
         * Public origin of THIS api-server, used as the OAuth 2.1 issuer + base for the AS/RS metadata
         * documents + the `/mcp` resource identifier (remote MCP flow). e.g.
         * https://api-staging.getting-things-done.app. Falls back to BETTER_AUTH_URL when unset.
         */
        MCP_OAUTH_ISSUER?: string;
        /** OAuth access-token TTL in seconds. Defaults to 3600 (1h). */
        MCP_OAUTH_ACCESS_TTL_SEC?: string;
        /** OAuth refresh-token TTL in seconds. Defaults to 2592000 (30d). */
        MCP_OAUTH_REFRESH_TTL_SEC?: string;
        /** Set to 'false' to disable open Dynamic Client Registration (RFC 7591). Enabled by default. */
        MCP_OAUTH_DCR_ENABLED?: string;
    }
}
