---
name: cross-tab-bridge-install-in-render
description: New module-level useSyncExternalStore stores tend to call their ensure*Bridge() side-effect from the component render body instead of at module import; flag it.
metadata:
  type: feedback
---

When a new feature adds a module-level `useSyncExternalStore` store (mirroring `accountReauthEvents.ts` / `hiddenAccounts.ts`), the paired `ensure*Bridge()` installer (which does `window.addEventListener`) is repeatedly wired up **inside the consuming component's render body** rather than at module top-level.

**Why:** The canonical sibling (`AccountReauthBanner.tsx`) calls `ensureAccountReauthBridge()` once at module import time, precisely so the listener installs exactly once and no side effect runs during render. New stores (e.g. `AccountVisibilityToggles.tsx` calling `ensureHiddenAccountsCrossTabBridge()` in render) drift from this — it still works because the installer is idempotency-guarded, but it violates the client/CLAUDE.md "no side effects during render" spirit and diverges from the pattern it claims to mirror.

**How to apply:** On any review touching a `contexts/*Events.ts` / module-store + `useSyncExternalStore` consumer, check where the bridge installer is called. It should be a top-level module statement in the consumer file, not a render-body call. Recommend hoisting it.
