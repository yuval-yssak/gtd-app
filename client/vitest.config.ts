import { defineConfig } from 'vitest/config';

export default defineConfig({
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
