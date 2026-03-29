// Shared across devLogin (dev-only route) and test helpers — single source of truth
// so a Better Auth upgrade that renames the cookie only requires one change.
export const SESSION_COOKIE_NAME = 'better-auth.session_token';
