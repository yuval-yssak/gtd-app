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
    use: {
        baseURL: 'http://localhost:4173',
        // Each test file gets fresh contexts — no shared browser state
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
    },
    webServer: [
        {
            command: 'cd ../api-server && npm run dev', // paths are relative to this config file in e2e/
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
