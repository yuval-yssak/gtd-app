---
name: use-cache-retry-resuspends-mounted
description: A use()-read module cache that swaps in a NEW pending promise during render (retry/TTL expiry) re-suspends already-mounted readers — the editor is hidden behind the Suspense fallback mid-typing.
metadata:
  type: feedback
---

Fixes for "use() over a failure-dropping cache spins forever" tend to add a retry window. If the retry is triggered by `loadX()` inside render, the first re-render after the window hands `use()` a fresh pending promise. React then hides the mounted tree (`display:none`) and shows the fallback until it settles. In an offline-first app this happens every window while offline.

**Why:** reproduced 2026-10-24 on useCalendarOptions (facelift batch 3 re-review) with a jsdom probe: after advancing past the window, a rerender showed `<p>loading</p>` and hid the reader.

**How to apply:** For any TTL or retry on a use() cache, require stale-while-revalidate: keep returning the settled promise and kick the refetch off in the background, swapping `cached` only once the new one settles. Ask for a jsdom test that re-renders a mounted reader past the window and asserts no fallback appears.
