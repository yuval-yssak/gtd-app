---
name: dep-bump-review-method
description: How to review api-server dependency bumps — diff old vs new node_modules (main checkout keeps the old tree); SDK wire changes are invisible to the mocked suite; Better Auth 1.7 linking gate
metadata:
  type: project
---

A "deps bump, all tests green" claim says little about the Anthropic / Google / Better Auth surfaces: the suite mocks `anthropicClient.js`, aborts outbound HTTP, and never runs a real OAuth sign-in. Reviewing the 2026-10-24 bump (chore/deps-update worktree) turned up these, none caught by tests:

- **@anthropic-ai/sdk 1.0** changed the wire protocol: `anthropic-version: 2026-10-21` (was 2023-06-01), and the API key is sent as `Authorization: Bearer` (was `X-Api-Key`). Typecheck can't see either. Ask for one live on-demand brief + one sweep batch before prod.
- **better-auth 1.7** added `accountLinking.requireLocalEmailVerified` (default true, deprecated: becomes unconditional next minor). Implicit linking into an existing `user` row with `emailVerified:false` now fails with "account not linked". `scripts/importFacileThings.ts` and `/dev/login` upsert users with `emailVerified:false`.
- Things that looked risky and turned out fine: the mongo adapter's new lazy `createIndex` only builds `table.indexes` (empty for this config); gaxios 8 still uses node-fetch in Node and still calls `errorRedactor`; googleapis-common 9 path validation leaves `{calendarId}` as single-segment; Better Auth's `isLikelyEncrypted` / `symmetricEncrypt` didn't change, so `betterAuthTokenCrypto.ts` still matches it.

**Why:** major bumps of SDKs that are mocked at the boundary ship untested wire and policy changes.
**How to apply:** for each major bump, diff `/Users/yuvalyssak/gtd/api-server/node_modules/<pkg>` (old) against the worktree's copy (new). Check changed defaults and auth/headers, not only renamed exports. Grep `emailVerified: false` writers whenever Better Auth moves. Related: [[verify-compile-before-trusting-pass-claims]]
