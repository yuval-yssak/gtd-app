---
name: self-heal-clear-races-flag-setters
description: When a warning store gains a "clear on success" self-heal hook, check every OTHER path that can set the flag — a success in one path routinely erases a live failure signal from another.
metadata:
  type: feedback
---

When a module-level warning store (e.g. reauth, sync-issues) gains a `clearXAfterSuccessfulY()` self-heal hook called from the happy path of one code path, audit **every** code path that can set the same flag before approving.

In this codebase the reauth flag is raised from at least four independent places: the sync orchestrator's per-user pass, the SSE handler's catch, `dispatchOpFlush`'s catch, and the Service Worker via `postMessage` into a tab. The self-heal hook typically gets added to only one of them and reads the flag set synchronously — so a success in path A silently erases a flag raised microseconds earlier by still-failing path B.

Two compounding factors to check:
1. **The clear usually also drops the dismissal/acknowledge tiers** (deliberately, so a future incident re-alerts). That turns the race into a visible nag loop: dialog opens → user dismisses → clear wipes the dismissal → re-flag re-opens the dialog.
2. **SW-originated flags arrive on a macrotask** (`postMessage`), so they have no happens-before relationship with a concurrent foreground sync pass at all.

**Why:** the whole point of the flag is that a broken-sync state must never go unnoticed; a clear that can fire against a still-broken account re-introduces exactly the silence the escalation exists to prevent.

**How to apply:** on any review adding a "clear on success" path to `contexts/*Events.ts` or `*Store.ts`, grep for every caller of the corresponding `flag*`/`dispatch*` function. Require that the clear only disproves a flag that **predates** the successful operation (capture the flagged state before the work begins), not whatever happens to be flagged when the work finishes. Related: [[two-tier-dismissal-stores]], [[cross-tab-bridge-install-in-render]].
