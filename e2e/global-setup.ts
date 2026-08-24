import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Playwright runs globalSetup ONCE before any worker spawns — the correct home for one-time builds.
// (Top-level config code re-executes per worker, so concurrent `npm run build` invocations would
// race on the same `dist/` and fail with "Command failed". Keep these here, not in the config body.)
//
// Failure-mode policy for both builds:
//   - Package not installed (no node_modules) → skip silently; the dependent spec surfaces the issue.
//   - Build fails (TS error, etc.) → propagate and fail the whole run. A stale bundle would just
//     hide the real error behind confusing UI-level failures.

// MCP package: `mcp-server.spec.ts` spawns `tools/mcp-gtd/dist/index.js`; a missing/stale dist is
// the most common reason that spec fails mysteriously.
function buildMcp(): void {
    const cwd = path.resolve(__dirname, '../tools/mcp-gtd');
    if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
        return;
    }
    execSync('npm run build', { cwd, stdio: 'inherit' });
}

// Client: the client webServer command is `npm run dev` (= `vite build --watch` + `vite preview`),
// but preview comes up and passes its health check before the watch-build finishes — so without a
// blocking build here, the first specs of a cold run hit a STALE/missing bundle (e.g. an old
// editor-open handler), which fails silently as "dialog never appears". Building up front guarantees
// the served bundle matches HEAD; the concurrent `--watch` then idles and `reuseExistingServer`
// still works for the keep-`npm run dev`-running iterative workflow.
//
// Deliberately `vite build` alone, NOT `npm run build`: the full build starts with
// generate-typed-css-modules, whose first step DELETES every src/**/*.css.d.ts before
// regenerating. The stop hook runs this e2e suite in parallel with the client block, so that
// delete lands mid-`tsc -b` and fails the client typecheck with TS6053 "file not found". The
// bundle doesn't need the .d.ts files (esbuild strips types), and typechecking is the client
// block's job — a type error still fails the hook through that block.
function buildClient(): void {
    const cwd = path.resolve(__dirname, '../client');
    if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
        return;
    }
    execSync('npx vite build', { cwd, stdio: 'inherit' });
}

export default function globalSetup(): void {
    buildMcp();
    buildClient();
}
