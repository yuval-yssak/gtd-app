import { defineConfig } from 'vitest/config';

export default defineConfig({
    // vite.config.ts stamps the real commit hash; tests get a fixed stand-in so assertions are stable.
    define: {
        __COMMIT_HASH__: JSON.stringify('abc1234'),
    },
    test: {
        environment: 'node',
        setupFiles: ['src/tests/setup.ts'],
    },
    resolve: {
        // Apply the 'test' condition so package.json `imports` like `#api/syncClient`
        // resolve to their mock companions (syncClient.mock.ts) without needing vi.mock().
        conditions: ['test'],
    },
});
