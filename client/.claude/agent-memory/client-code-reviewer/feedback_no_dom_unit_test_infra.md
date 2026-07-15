---
name: no-dom-unit-test-infra
description: Client vitest runs in node env with no jsdom/testing-library and zero render() component tests — do NOT request a component render test as a fix; route DOM/router-bound coverage to Playwright e2e.
metadata:
  type: feedback
---

The client's vitest config uses `environment: 'node'` (`vitest.config.ts`), and there is no `jsdom`/`happy-dom`, no `@testing-library`, and no existing `render()`-based component test in `src/tests`. A review recommendation of "add a component test that renders `<X/>`, mocks a hook, clicks a button" is therefore **not achievable** without standing up new DOM test infrastructure — which the team has deliberately deferred.

**Why:** I flagged a missing `UndoSnackbar` render test (mock `useNavigate`, click the View button) as Changes-requested; it was un-runnable in this env, and I had to walk the verdict back to Approved-with-suggestions. The same constraint is documented in [[passthrough-helper-untests-wiring]] as an accepted tradeoff.

**How to apply:** When the untested logic is DOM/router/click-bound (conditional JSX rendering, an `onClick` that calls `navigate`/router APIs, focus behavior), do NOT request a vitest component test as the fix. Instead: (a) recommend a **Playwright e2e** (this repo's norm is unit + e2e per step) exercising the real gesture, or (b) recommend extracting the pure decision out of the component so it's unit-testable in `node`. Only escalate to Changes-requested over such a gap if pure/store-level logic that CAN be tested in `node` was left uncovered. Before writing the recommendation, confirm the env constraint still holds (grep `environment` in `vitest.config.ts`; grep `@testing-library`/`jsdom` in `package.json`) — if DOM infra later lands, this memory is stale.
