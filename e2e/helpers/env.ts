/**
 * The e2e stack's own ports. Playwright starts a dedicated API and client here for every run (see
 * playwright.config.ts) instead of reusing whatever dev server holds 4000/4173 — a reused server
 * keeps ITS environment (timezone, BRIEF_FAKE_MODEL) and possibly another worktree's code. Override
 * both to run two worktrees' suites side by side.
 */
export const E2E_API_PORT = Number(process.env.GTD_E2E_API_PORT ?? 4100);
export const E2E_CLIENT_PORT = Number(process.env.GTD_E2E_CLIENT_PORT ?? 4273);

export const API_URL = `http://localhost:${E2E_API_PORT}`;
export const CLIENT_URL = `http://localhost:${E2E_CLIENT_PORT}`;

/** The e2e bundle's output directory, inside client/ (`dist-*` is gitignored). */
// The build bakes API_URL in (VITE_API_SERVER). Two worktrees side by side stay apart only because
// each builds into its own client/ — never point two suites at one output dir.
export const E2E_CLIENT_OUT_DIR = 'dist-e2e';
