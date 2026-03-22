// dotenv is loaded in index.ts via `import 'dotenv/config'` — just read process.env here
export const mongoDBConfig = {
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation here
    dbName: process.env['MONGO_DB_NAME'] ?? '',
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation here
    DBUrl: process.env['MONGO_DB_URL'] ?? '',
};

export const googleOAuthConfig = {
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation here
    clientID: process.env['GOOGLE_OAUTH_APP_CLIENT_ID'] ?? '',
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation here
    clientSecret: process.env['GOOGLE_OAUTH_APP_CLIENT_SECRET'] ?? '',
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation here
    redirectUri: process.env['GOOGLE_REDIRECT_URI'] ?? '',
};

export const githubOAuthConfig = {
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation here
    clientID: process.env['GITHUB_CLIENT_ID'] ?? '',
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation here
    clientSecret: process.env['GITHUB_CLIENT_SECRET'] ?? '',
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation here
    redirectUri: process.env['GITHUB_REDIRECT_URI'] ?? '',
};

export const authConfig = {
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation here
    jwtSecret: process.env['JWT_SECRET'] ?? 'your_jwt_secret',
};

// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation here
export const clientUrl = process.env['CLIENT_URL'] ?? 'http://localhost:5173';
