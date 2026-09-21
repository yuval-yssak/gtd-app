import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { findMockingTestFiles } from './src/tests/mockingTestFiles.js';

// Files that stub a module with `vi.mock` must keep a process to themselves (see
// findMockingTestFiles). Detected at config time so a new `vi.mock` caller is isolated
// automatically; resolved against this file, not the cwd, so a root-level invocation sees them too.
const mockingTestFiles = findMockingTestFiles(fileURLToPath(new URL('src/tests', import.meta.url)));

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
        // Test files run in parallel workers. Each worker gets its own MongoDB database
        // (mainLoader.namespaceTestDB suffixes the db name with the run's pid + VITEST_POOL_ID), so
        // a beforeEach wipe in one file can never touch OAuth state another file's in-flight login
        // still needs. Files that land on the same worker run sequentially, as before.
        fileParallelism: true,
        // Each run namespaces its test DBs by process.ppid + worker id (see mainLoader.namespaceTestDB)
        // so two concurrent `npm run test` invocations don't collide on `gtd_test`; this teardown
        // drops the databases this run created once everything finishes.
        globalSetup: ['src/tests/globalTeardown.ts'],
        // Every file's beforeAll builds ~25 indexes in its own fresh database, and mongod runs at most
        // 3 index builds at a time; with a dozen workers starting files together the queue can hold a
        // beforeAll well past the 10 s default — a spurious "Hook timed out", not a real failure.
        hookTimeout: 60_000,
        projects: [
            {
                extends: true,
                test: { name: 'isolated', include: mockingTestFiles, isolate: true },
            },
            {
                extends: true,
                test: {
                    name: 'shared',
                    include: ['src/tests/**/*.test.ts'],
                    exclude: ['**/node_modules/**', '**/build/**', ...mockingTestFiles],
                    // Reuse worker processes across files. With `isolate: true` every file gets a fresh
                    // process and re-evaluates node_modules from scratch (googleapis alone is ~360 ms) —
                    // ~1 s of import per file, the largest single cost of the suite. Node's native module
                    // cache now keeps those warm, while setup.ts resets vitest's own module registry after
                    // each file so our src/ modules (DAO singletons, in-memory maps, timers) are still
                    // evaluated fresh per file and nothing leaks between files.
                    isolate: false,
                },
            },
        ],
    },
});
