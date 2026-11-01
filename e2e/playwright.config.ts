import * as path from 'node:path';
import { defineConfig } from '@playwright/test';
import { API_URL, CLIENT_URL, E2E_API_PORT, E2E_CLIENT_OUT_DIR, E2E_CLIENT_PORT } from './helpers/env';

/** `GTD_E2E_WORKERS` as Playwright takes it: a count (`6`) or a share of the cores (`50%`). */
function parseWorkers(override: string | undefined) {
    if (!override) {
        return '75%';
    }
    return override.endsWith('%') ? override : Number(override);
}

export default defineConfig({
    testDir: '.', // config lives in e2e/ — tests are in the same directory
    // Builds the MCP packages once before any worker starts (see global-setup.ts). Lives in
    // globalSetup, NOT the config body, because the config module re-evaluates per worker — concurrent
    // `npm run build` invocations would race on the same dist/ and fail.
    globalSetup: path.resolve(__dirname, 'global-setup.ts'),
    timeout: 30_000,
    // No retries: a test that passes only on a second attempt is flaky, and a retry would hide it.
    retries: 0,
    // 75% of the cores (9 on the 12-core Mac). The suite is CPU-bound in the browsers — the API sits
    // near a quarter of one core and Mongo at a tenth while Chromium takes the rest — so more workers
    // only stretch each test: at 12 the wall time drops a little further but post-action polls start
    // timing out. Measured 2026-10-30 on 556 tests: 6 workers 3.1 min, 9 workers 2.4 min, 12 workers
    // 2.1 min with failures. The stop hook passes --workers=2 itself (it runs beside the vitest suites).
    workers: parseWorkers(process.env.GTD_E2E_WORKERS),
    // Tests of one file spread across workers. Per-file scheduling left 8 of 9 workers idle for the
    // last 50–66s of every run while one worker finished a 23-test file alone.
    fullyParallel: true,
    use: {
        baseURL: CLIENT_URL,
        // Each test gets fresh contexts — no shared browser state.
        // Both recorders stay off: on a 133-test subset the suite cost 259 CPU-seconds with neither,
        // 415 with the trace alone and 569 with trace + video, and the run is CPU-bound. A failure
        // still gets its ARIA snapshot (error-context.md); for a trace, rerun the spec with
        // GTD_E2E_TRACE=1.
        trace: process.env.GTD_E2E_TRACE === '1' ? 'retain-on-failure' : 'off',
        video: 'off',
        // A fresh context would otherwise install the PWA's service worker, which precaches the whole
        // bundle (~200 requests, 4 MB) — about 0.8 CPU-seconds per context across Chromium and the
        // preview server, for ~650 contexts a run. No spec needs it: the offline specs never reload
        // while offline (the e2e shell is not served from the cache) and push registration is seeded
        // server-side. A spec that does need it opts back in with `test.use({ serviceWorkers: 'allow' })`.
        serviceWorkers: 'block',
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
