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
        // Run test files sequentially — within one run, files share the same (now PID-namespaced)
        // MongoDB database, so concurrent file execution would let beforeEach cleanup in one file
        // wipe OAuth state records that another file's in-flight login still needs.
        fileParallelism: false,
        // Each run namespaces its test DBs by process.ppid (see mainLoader.namespaceTestDB) so two
        // concurrent `npm run test` invocations don't collide on `gtd_test`; this teardown drops the
        // databases this run created once everything finishes.
        globalSetup: ['src/tests/globalTeardown.ts'],
    },
});
