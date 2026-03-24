// Falls back to empty string in prod — Vite replaces VITE_* vars at build time,
// so the actual value must be set in the Cloudflare Pages dashboard.
// Falls back to empty string in prod — Vite replaces VITE_* vars at build time,
// so the actual value must be set in the Cloudflare Pages dashboard.
export const API_SERVER = import.meta.env.VITE_API_SERVER ?? '';
