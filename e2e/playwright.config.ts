import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineConfig } from '@playwright/test';

// Build the MCP package up front — `mcp-server.spec.ts` spawns `tools/mcp-gtd/dist/index.js`
// and a missing or stale `dist/` is the most common reason for that spec to fail mysteriously.
//
// Failure-mode policy:
//   - Package not installed (no node_modules) → skip silently, the spec surfaces the missing dist.
//   - Build fails (TS error, etc.) → propagate and fail the whole Playwright run. The build error
//     is the actual problem; running tests against a stale dist would just hide it.
function buildMcp(): void {
    const cwd = path.resolve(__dirname, '../tools/mcp-gtd');
    if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
        return;
    }
    // stdio: 'inherit' so a TS error lands directly in the runner output instead of being
    // captured into an opaque execSync exception.
    execSync('npm run build', { cwd, stdio: 'inherit' });
}
buildMcp();

export default defineConfig({
    testDir: '.', // config lives in e2e/ — tests are in the same directory
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
