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
    }
}
