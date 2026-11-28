---
name: e2e-goto-resets-module-store
description: E2E specs that "prove" an in-memory module store's write-through by page.goto-ing afterwards are vacuous — goto is a full reload that wipes the store.
metadata:
  type: project
---

Module-level in-memory stores (per-user status caches, event stores) get a write-through from one page (e.g. Settings) to another. Specs then assert it with `page.goto(...)` to the other page — a full document reload that discards the module, so the assertion passes from a fresh server read and the write-through goes untested at every layer. Seen in the Ask Claude not-connected change (2026-11-27).

**Why:** the spec comment claims "without waiting for the status to go stale", and that coverage is never actually there.

**How to apply:** when a change adds a module-memory cache plus a write-through, check that the spec navigates client-side (a nav Link click, `page.goBack()`) rather than goto, or that a unit test covers the writer. Also check that an in-flight check started before the write cannot land after it and overwrite it. Related: [[no-dom-hook-test-gap]].
