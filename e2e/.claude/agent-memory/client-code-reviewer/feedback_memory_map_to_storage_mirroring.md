---
name: memory-map-to-storage-mirroring
description: When an in-memory Map gains a Web Storage mirror, the eviction/TTL path and the unbounded-key-growth path are the two things that get left behind.
metadata:
  type: feedback
---

When a module-level `Map` cache in this codebase is promoted to "also persist to
sessionStorage/localStorage", the mirror is wired into the **write** path only. Two
things are consistently missed:

1. **Eviction is not mirrored.** The map's TTL/staleness delete (`map.delete(k)` inside
   the read-and-expire function) does not re-serialize, so storage keeps the entry
   forever. On the next hydrate the *expired* entry comes back — and if hydrate also
   refreshes `savedAtMs`/age for the current key, an entry the user already saw expire
   is resurrected as fresh. The TTL becomes unenforceable across reloads.
2. **No eviction policy at all on the persisted set.** In-memory unbounded growth is
   harmless (dies with the tab); persisted unbounded growth is a quota bug. Keys derived
   from URLs including search params (`/search?q=...`, filter chips) churn one new key
   per debounced keystroke, so the persisted object grows far faster than the reviewer's
   intuition of "one key per list page" suggests.

**Why:** the author reasons about the mirror as a dumb write-through of the map, so the
map's own lifecycle rules (expiry, capacity) are assumed to carry over. They don't — the
map's rules are enforced lazily at read time on a single key, and storage never sees them.

**How to apply:** on any diff that adds `setItem`/`getItem` alongside an existing
in-memory cache, ask three questions explicitly: (a) does every `map.delete`/`map.clear`
also re-persist? (b) what bounds the number of persisted keys, and does any key contain a
free-text URL param? (c) does hydration re-admit entries the TTL already rejected? Also
check that `setItem` is wrapped for `QuotaExceededError` — the try/catch is usually there
for private-mode, which happens to cover quota too, but confirm the map stays intact when
it throws.

Related: [[feedback_conditional_render_gate_loses_coverage]]
