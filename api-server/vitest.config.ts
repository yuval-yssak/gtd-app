import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        // dotenv/config must run before any test file is evaluated so that config.ts
        // (which reads process.env at module init time) sees the env vars
        setupFiles: ['dotenv/config', 'src/tests/setup.ts'],
        // Suppress reporter echo of stdout/stderr blocks — the setup.ts stubs already
        // silence console.*, this catches anything that writes to the streams directly
        // (e.g. tests that preserve a real spy) so the stop-hook transcript stays slim.
        onConsoleLog: () => false,
        // Exclude compiled JS output — only run TypeScript sources
        exclude: ['**/node_modules/**', '**/build/**'],
        // Run test files sequentially — all test files share the same gtd_test MongoDB
        // database, so concurrent file execution causes beforeEach cleanup in one file
        // to wipe OAuth state records that another file's in-flight login still needs.
        fileParallelism: false,
    },
});
