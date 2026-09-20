---
name: dom-predicate-faked-in-node-tests
description: Pure helpers wrapping a DOM API (closest/matches/contains) get unit tests that stub the very method under test, so the tests prove nothing about real behavior
metadata:
  type: feedback
---

Client vitest runs `environment: 'node'` (no DOM). When a change extracts a DOM-touching predicate
into `lib/` to make it "unit testable", the test hands in `{ closest: (sel) => sel === 'a[href]' ? x : null }`
— a fake that *is* the logic. The test then only re-asserts the stub, plus the `typeof === 'function'`
duck-type guard. Coverage looks green while the actual question (does the real event target inside a
rendered `<a>` resolve?) is untested.

**Why:** the interesting behavior lives in the browser: text-node targets have no `closest`, SVG icon
children do, shadow boundaries don't cross, and `currentTarget` vs `target` differ for keyboard
events dispatched on the container rather than the inner link. None of that is reachable from a
node-env stub.

**How to apply:** for extracted DOM predicates, accept the node-env unit test only as a null/duck-type
guard, and insist the *semantic* cases (inside-link, outside-link, keyboard-on-container vs
keyboard-on-link) are pinned in Playwright, where a real DOM exists. Also check `.test.tsx` precedent
files (`calendarSelectRows.test.tsx`) — element-shape assertions on returned JSX are the accepted
node-env way to test a small render component without a DOM.

Related: [[feedback_testid_constant_lists_untethered_from_render]]
