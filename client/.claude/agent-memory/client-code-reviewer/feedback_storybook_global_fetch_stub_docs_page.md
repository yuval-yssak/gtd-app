---
name: storybook-global-fetch-stub-docs-page
description: Per-story window.fetch stubs in Storybook beforeEach chain on a shared window; on autodocs pages the last-installed story config answers every story, and non-LIFO cleanup leaks a stub chain.
metadata:
  type: feedback
---

Storybook runs project → component → story `beforeEach` in order and their cleanups in reverse **per story** (verified in storybook 10 `applyBeforeEach` / `cleanupStory`). But `window.fetch` is one global: on an `autodocs` page every story's stub wraps the previous story's, so the last story's config (often ErrorState) answers the requests of every rendered story, and cross-story cleanup order is not LIFO, which leaves a stale chain installed.

**Why:** the old useEffect-decorator mock had the same flaw; moving to beforeEach fixed the canvas timing but not docs mode. Better Auth's `customFetchImpl` defaults to the `fetch` captured at module load, so it bypasses later stubs unless it is late-bound.

**How to apply:** when a story stubs `window.fetch`, check for `tags: ['autodocs']` on the meta. Suggest a parameters-driven project-level stub keyed by story id, or exclude those stories from docs. Treat it as a non-blocking suggestion unless the docs page is a review artifact.
