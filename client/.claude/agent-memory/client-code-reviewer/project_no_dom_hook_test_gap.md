---
name: no-dom-hook-test-gap
description: Vitest runs in node env with no DOM, so hooks (useAccounts etc.) and components are routinely shipped untested; logic gets lifted into plain modules to make it testable
metadata:
  type: project
---

UPDATE 2026-11-20: per-file `// @vitest-environment jsdom` + @testing-library/react render tests now exist (usePageEscapeToClose.test.tsx, useEscapeStepsOutOfFields.test.tsx), so a hook render test is an acceptable ask; jsdom lacks isContentEditable. Original note: this client's vitest runs in `node` env with no DOM. Component render and hook behavior are NOT unit-testable by convention — tests inspect plain functions/stores/element trees instead.

**Why:** No jsdom/happy-dom configured. The team's workaround is to lift testable logic OUT of hooks/components into plain modules (e.g. banner state → `accountReauthEvents.ts` store, tested directly).

**How to apply:** Recurring blind spot — new hook surface (e.g. `reauthForUserId` in `useAccounts.ts`) and component branches ship with zero unit coverage and only Playwright e2e (if any). When you see logic that matters living inside a hook/component, the right reviewer ask is "lift it into a plain module and test that," not "add a render test." Flag untested hook branches but treat the lift-and-test response as the expected resolution. Related: [[project-sync-flags-unit-test-gap]], [[event-banner-component-untested]].
