// dotenv is loaded in index.ts via `import 'dotenv/config'` — just read process.env here
export const mongoDBConfig = {
    dbName: process.env['MONGO_DB_NAME'] ?? '',
    DBUrl: process.env['MONGO_DB_URL'] ?? '',
}

export const googleOAuthConfig = {
    clientID: process.env['GOOGLE_OAUTH_APP_CLIENT_ID'] ?? '',
    clientSecret: process.env['GOOGLE_OAUTH_APP_CLIENT_SECRET'] ?? '',
    redirectUri: process.env['GOOGLE_REDIRECT_URI'] ?? '',
}

export const authConfig = {
    jwtSecret: process.env['JWT_SECRET'] ?? 'your_jwt_secret',
}

export const clientUrl = process.env['CLIENT_URL'] ?? 'http://localhost:5173'
