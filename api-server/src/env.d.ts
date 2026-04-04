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
    }
}
