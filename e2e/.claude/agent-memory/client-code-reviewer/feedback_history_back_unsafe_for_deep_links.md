---
name: window.history.back() is unsafe for direct-navigation page routes
description: Page-mode editor routes should use navigate({ to: '<canonical-list>' }), not window.history.back(), or they exit the app on direct deep-link entry.
type: feedback
---

Page-mode entity editor routes (`/item/$itemId`, `/routine/$routineId`, etc.) typically wire their back button + onClose to `() => window.history.back()`. This works when the user navigated to the page from inside the app (the back stack has a sibling app route to return to), but fails for the direct-navigation path: copy/paste URL, share-link, push notification deep link, or first-tab landing. In those cases `history.back()` exits the SPA entirely (back to the previous origin or closes the tab).

**Why:** SPAs that share entity URLs externally need a deterministic in-app fallback — the user expects "back" on a deep-linked page to take them to the canonical list view, not out of the app.

**How to apply:** When reviewing a new page-mode route, verify it uses `navigate({ to: '/<canonical-list>' })` (or the item route's `backRouteForStatus(status)` pattern) rather than `window.history.back()`. The item route does this correctly; new routes (routine page route added 2026-05) sometimes regress to `history.back()`. Flag and suggest the navigate fallback explicitly.
