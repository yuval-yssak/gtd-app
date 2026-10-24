---
name: no-dom-unit-test-infra
description: SUPERSEDED (facelift branch, 2026-10) — jsdom + @testing-library now exist; per-file `// @vitest-environment jsdom` render tests are allowed. Router-bound components (useBlocker) still route to e2e.
metadata:
  type: feedback
---

Historically the client vitest ran `environment: 'node'` with no jsdom/testing-library, and requesting a render test was un-runnable (I once had to walk a Changes-requested verdict back over an `UndoSnackbar` render test).

As of the Base UI facelift (feat/base-ui-facelift, seen 2026-10-24) `jsdom`, `@testing-library/react|dom|user-event` are devDependencies and files opt in with `// @vitest-environment jsdom` (e.g. `usePageEscapeToClose.test.tsx`, `listRowShell.test.tsx`, `useIsMobile.test.tsx`).

**Why:** the old constraint was real but has been lifted; a stale memory would make me under-ask for hook/DOM tests.

**How to apply:** Hook and plain-DOM component tests are now a legitimate ask. Components that need the TanStack router (`useBlocker`, `useNavigate`) or IDB/AppData providers are still expensive to render — prefer Playwright e2e or extracting the pure decision there. Grep `package.json` for jsdom before relying on either version of this note. Related: [[passthrough-helper-untests-wiring]].
