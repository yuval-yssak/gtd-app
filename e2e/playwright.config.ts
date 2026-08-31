import * as path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: '.', // config lives in e2e/ — tests are in the same directory
    // Builds the MCP package + client once before any worker starts (see global-setup.ts). Lives in
    // globalSetup, NOT the config body, because the config module re-evaluates per worker — concurrent
    // `npm run build` invocations would race on the same dist/ and fail.
    globalSetup: path.resolve(__dirname, 'global-setup.ts'),
    timeout: 30_000,
    retries: 1, // one retry on flake — E2E tests can be timing-sensitive
    // Cap workers well below Playwright's default (≈half the 12 cores = 6). The stop-hook runs this
    // e2e suite IN PARALLEL with the client + api-server vitest suites (each with its own worker pool)
    // against one local Mongo, often alongside the developer's own Chrome; 6 browsers on top of that
    // oversubscribed the machine and starved operations past their timeouts. 2 keeps each browser
    // adequately fed under that concurrent load while still parallelising e2e.
    workers: 2,
    use: {
        baseURL: 'http://localhost:4173',
        // Each test file gets fresh contexts — no shared browser state
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
    },
    webServer: [
        {
            // TZ=UTC pins the API server to Cloud Run's clock environment, so the timezone-pipeline
            // specs exercise the same server-local-vs-user-local split production has. Note
            // reuseExistingServer below: a dev server already running keeps ITS timezone — restart
            // it under TZ=UTC when working on the timezone specs. (Paths are relative to e2e/.)
            command: 'cd ../api-server && TZ=UTC npm run dev',
            url: 'http://localhost:4000/sync/config',
            reuseExistingServer: true,
            stdout: 'ignore',
            stderr: 'ignore',
        },
        {
            command: 'cd ../client && npm run dev',
            url: 'http://localhost:4173',
            reuseExistingServer: true,
            stdout: 'ignore',
            stderr: 'ignore',
        },
    ],
});
