---
name: ci-typecheck-cross-package-imports
description: api-server typecheck now covers src/tests, and mcpToolParity.test.ts imports ../mcp-server sources — CI only installs api-server deps, so those bare imports (zod, @modelcontextprotocol/sdk) don't resolve there
metadata:
  type: project
---
CI (`.github/workflows/ci.yml`) runs `npm install` only in `api-server/`. Since 2026-10-27 (tsrs worktree), `npm run typecheck` includes `src/tests`, and `mcpToolParity.test.ts` pulls in `../mcp-server/src/tools/*.ts`. Their bare `zod` / `@modelcontextprotocol/sdk` imports resolve from `mcp-server/node_modules`, which doesn't exist in CI. The result is 16 TS2307 errors there, while locally everything is green. I reproduced it by copying the two packages to a scratch dir with no mcp-server/node_modules.

**Why:** the local stop hook and a dev checkout always have every package installed, so "typecheck passes locally" can't catch it.

**How to apply:** whenever a change widens the api-server tsconfig `include`, or adds a test that imports another package's source, check whether CI installs that package. The fix is either a CI install step for the package (`npm ci --ignore-scripts` in mcp-server) or a tsconfig `paths` mapping. Reproduce outside the monorepo, not in it, because a nested worktree can resolve modules from the parent checkout. Related: a stale nested `src/tests/tsconfig.json` (a looser, standalone config) makes editors disagree with `npm run typecheck` once the parent includes tests.
