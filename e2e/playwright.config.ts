import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: '.', // config lives in e2e/ — tests are in the same directory
    timeout: 30_000,
    retries: 1, // one retry on flake — E2E tests can be timing-sensitive
    use: {
        baseURL: 'http://localhost:4173',
        // Each test file gets fresh contexts — no shared browser state
    },
    webServer: [
        {
            command: 'cd api-server && npm run dev',
            url: 'http://localhost:4000/sync/config',
            reuseExistingServer: true,
        },
        {
            command: 'cd client && npm run dev',
            url: 'http://localhost:4173',
            reuseExistingServer: true,
        },
    ],
});
