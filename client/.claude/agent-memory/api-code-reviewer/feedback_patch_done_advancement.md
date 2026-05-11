---
name: PATCH /v1/items vs POST /complete asymmetry
description: PATCH and POST /complete both let an item reach 'done', but only POST /complete triggers routine advancement — easy to miss when reviewing new disposal-side-effect features
type: feedback
---

When a feature adds a side effect that fires on item disposal (routine advancement, archival, etc.), reviewers must check BOTH transition paths:
1. `POST /v1/items/:id/complete` — the dedicated shortcut.
2. `PATCH /v1/items/:id` with `{status: 'done'}` — equally supported per `v1Clarify.test.ts`.

Disposal hooks have been added to `/complete` but missed on `/patch` in at least one PR (server-side routine item generation, 2026-05). The trash transition is forbidden at PATCH (returns 409), so trash-side hooks don't need PATCH coverage — but the `done` transition is allowed.

**Why:** PATCH→done is the idiomatic edit path for non-MCP integrations and headless scripts that prefer general PATCH over verb-style shortcuts. The author of the disposal feature usually adds the hook to /complete because that's where they were thinking, and forgets PATCH has the same outcome via a different entry point.

**How to apply:** When reviewing any new disposal-side-effect, grep for both `completeItem` and `patchItem`. If only one calls the new hook, flag it as a correctness bug, not a style nit. The trash-path PATCH guard (`if (raw['status'] === 'trash') ...`) is a useful precedent for documenting the asymmetry; the same comment block should also reason about `done` even when no fix is needed.
