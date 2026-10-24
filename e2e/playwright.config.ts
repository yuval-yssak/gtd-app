import * as path from 'node:path';
import { defineConfig } from '@playwright/test';
import { API_URL, CLIENT_URL, E2E_API_PORT, E2E_CLIENT_OUT_DIR, E2E_CLIENT_PORT } from './helpers/env';

export default defineConfig({
    testDir: '.', // config lives in e2e/ — tests are in the same directory
    // Builds the MCP packages once before any worker starts (see global-setup.ts). Lives in
    // globalSetup, NOT the config body, because the config module re-evaluates per worker — concurrent
    // `npm run build` invocations would race on the same dist/ and fail.
    globalSetup: path.resolve(__dirname, 'global-setup.ts'),
    timeout: 30_000,
    // No retries: a test that passes only on a second attempt is flaky, and a retry would hide it.
    retries: 0,
    // Cap workers well below Playwright's default (≈half the 12 cores = 6). The stop-hook runs this
    // e2e suite IN PARALLEL with the client + api-server vitest suites (each with its own worker pool)
    // against one local Mongo, often alongside the developer's own Chrome; 6 browsers on top of that
    // oversubscribed the machine and starved operations past their timeouts. 2 keeps each browser
    // adequately fed under that concurrent load while still parallelising e2e.
    workers: 2,
    use: {
        baseURL: CLIENT_URL,
        // Each test file gets fresh contexts — no shared browser state
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
    },
    // The e2e stack always starts its own API and client on dedicated ports (helpers/env.ts) and never
    // reuses a running server: a developer's dev server on 4000/4173 keeps ITS environment and may run
    // another worktree's code. A port already taken fails the run loudly instead.
    webServer: [
        {
            // TZ=UTC pins the API server to Cloud Run's clock environment, so the timezone-pipeline
            // specs exercise the same server-local-vs-user-local split production has.
            // BRIEF_FAKE_MODEL=1 swaps the Anthropic call behind brief generation for a deterministic
            // fake (`[fake] <first sentence of the notes>`), so the brief specs need no key.
            // The URL variables win over api-server/.env (dotenv never overrides the environment).
            // Plain `tsx`, not `tsx watch`: an edit mid-run must not restart the server under a test.
            command: `cd ../api-server && TZ=UTC BRIEF_FAKE_MODEL=1 PORT=${E2E_API_PORT} BETTER_AUTH_URL=${API_URL} CLIENT_URL=${CLIENT_URL} npx tsx src/index.ts`,
            url: `${API_URL}/sync/config`,
            reuseExistingServer: false,
            stdout: 'ignore',
            stderr: 'ignore',
        },
        {
            // Builds the e2e bundle against the e2e API, then serves it; the preview proxy forwards there
            // too. The build lives here, not in global-setup: Playwright starts web servers BEFORE
            // global setup, so the preview's health check would otherwise poll a missing bundle.
            // VITE_API_SERVER in the environment beats client/.env (which targets the dev API).
            // `vite build` alone, NOT `npm run build`: the full build's generate-typed-css-modules
            // deletes every src/**/*.css.d.ts first, which would break the client typecheck the stop
            // hook runs in parallel.
            command: `cd ../client && VITE_API_SERVER=${API_URL} npx vite build --outDir ${E2E_CLIENT_OUT_DIR} --emptyOutDir --logLevel warn && GTD_API_PROXY_TARGET=${API_URL} npx vite preview --outDir ${E2E_CLIENT_OUT_DIR} --port ${E2E_CLIENT_PORT} --strictPort`,
            url: CLIENT_URL,
            reuseExistingServer: false,
            // The build comes first, so allow more than the default minute.
            timeout: 180_000,
            stdout: 'ignore',
            stderr: 'ignore',
        },
    ],
});
