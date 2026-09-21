---
name: new-sync-trigger-inherits-unmountedref-latch
description: New syncAndRefresh triggers in AppDataProvider inherit the unguarded getOrCreateDeviceId().then(openSse) hole. The unmountedRef latch looks like a bug on inspection but is NOT one at runtime — verify before reporting.
metadata:
  type: feedback
---

When a new sync trigger is added to `AppDataProvider` (resume/visibility, focus, timer, etc.), it copies the shape of the existing boot / isOnline effects and inherits two latent defects that the copied code never surfaced:

1. **`unmountedRef` never being reset is NOT a live bug — do not report it as one.** It is set `true` in the boot effect's cleanup (line ~502) with no reset, and `isFirstOnlineRender` right beside it *does* get reset, which makes it look like an oversight. It is not: `AppDataProvider` mounts under the `<Suspense>` boundary in `main.tsx`, and the boot effect suspends on app data, so React discards the initial Strict Mode pass before its effects+cleanup ever commit. Verified empirically 2026-09-21 by logging `unmountedRef.current` at the guard inside `syncAndRefresh` during a real resume in Playwright: it reads **`false`**, `triggerAppResourceRefresh('all')` runs, and the UI repaints. Reasoning about Strict Mode ref retention statically gives the wrong answer here — instrument the running app before claiming this one.

2. **`getOrCreateDeviceId(db).then(open/reopenSseConnections(...))` with no unmount guard.** The boot effect guards this exact `.then()` with a local `unmounted` flag; the isOnline effect does not, and new triggers copy the unguarded form. Cleanup order means `closeSseConnections()` runs first, then the late `.then()` re-opens N EventSources that nothing will ever close. Exposure scales with trigger frequency — a visibility/resume trigger fires orders of magnitude more often than a connectivity transition.

**Why:** the house e2e style asserts through the `window.__gtd` harness (`listItems()`, `sseChannelUserIds()`), never the rendered DOM. That is a real coverage limit — but note a DOM assertion is *not* a usable substitute in a two-device spec: the server sends a Web Push on every write, and the SW's push handler pulls and posts `sync-complete`, which repaints the list on its own. A "resume repaints the list" DOM test therefore passes even with the resume trigger fully disabled. Attempted 2026-09-21 (severing SSE *and* unregistering the SW still wasn't enough to isolate it) and dropped rather than shipped as a test that can't fail.

**How to apply:** on any diff adding a `syncAndRefresh()` / `openSseConnections()` caller in `AppDataProvider`, check that the async `.then()` is unmount-guarded (defect 2) — that one is real and worth requesting. Do not request an `unmountedRef` reset without instrumenting the running app first. Before demanding a DOM-level test, confirm the assertion can actually fail when the feature is disabled; in this provider the Web Push path usually means it cannot. Relates to [[feedback-fixed-critical-ships-without-its-e2e]] and [[feedback-dom-predicate-faked-in-node-tests]].
