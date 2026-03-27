import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: 'e2e',
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
