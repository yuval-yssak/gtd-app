import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        // dotenv/config loads api-server/.env so GOOGLE_OAUTH_APP_CLIENT_ID etc. are available.
        setupFiles: ['dotenv/config'],
        // This suite also runs under NODE_ENV=test, so loadDataAccess namespaces its `gtd_test_sync_audit`
        // DB by process.ppid (see mainLoader.namespaceTestDB). Wire the same teardown so the per-run
        // database is dropped afterwards instead of leaking a fresh `gtd_test_sync_audit_p<pid>` each run.
        globalSetup: ['src/tests/globalTeardown.ts'],
        include: ['src/tests-sync-audit/scenarios/**/*.audit.ts'],
        // Real Mongo + real Google Calendar API — never run in parallel.
        // Scenarios within a file share setup (one user, one integration) and
        // each scenario triggers real network I/O, so sequential execution is required.
        fileParallelism: false,
        sequence: { concurrent: false },
        // Budget per scenario: real Google API calls are slow (~1-2s each) and a
        // single scenario may make 5-10 calls. 60s per test is defensive.
        testTimeout: 60_000,
        hookTimeout: 60_000,
        // Pass-through reporter shows per-scenario progress; the custom reporter
        // writes the markdown artifact.
        reporters: ['default', './src/tests-sync-audit/harness/reporter.ts'],
    },
});
