import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Playwright runs globalSetup ONCE before any worker spawns — the correct home for one-time builds.
// (Top-level config code re-executes per worker, so concurrent `npm run build` invocations would
// race on the same `dist/` and fail with "Command failed". Keep these here, not in the config body.)
//
// Failure-mode policy for the builds:
//   - Package not installed (no node_modules) → skip silently; the dependent spec surfaces the issue.
//   - Build fails (TS error, etc.) → propagate and fail the whole run. A stale bundle would just
//     hide the real error behind confusing UI-level failures.

// MCP packages: `mcp-server.spec.ts` spawns `tools/mcp-gtd/dist/index.js` (the superseded binary)
// and `mcp-field-guidance.spec.ts` spawns `mcp-server/dist/index.js` (the current one); a
// missing/stale dist is the most common reason either spec fails mysteriously.
function buildMcp(): void {
    for (const packageDir of ['../tools/mcp-gtd', '../mcp-server']) {
        const cwd = path.resolve(__dirname, packageDir);
        if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
            // Say so: the dependent spec otherwise fails with an opaque "MCP spawn failed / exited".
            console.warn(`[global-setup] ${packageDir} has no node_modules — skipping its build; its MCP spec will fail until you npm install there`);
            continue;
        }
        execSync('npm run build', { cwd, stdio: 'inherit' });
    }
}

// The client bundle is built by its web server command (playwright.config.ts): Playwright starts web
// servers before global setup, so a build here would come too late for the preview's health check.
export default function globalSetup(): void {
    buildMcp();
}
