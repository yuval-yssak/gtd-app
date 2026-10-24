---
name: url-before-commit-misattributed
description: TanStack Router >=1.170 updates the URL before the render transition commits; e2e flakes from this get misattributed to the browser/Playwright version
metadata:
  type: project
---

Since router 1.170, `status` stays 'pending' through the React transition and the URL changes before the destination render commits. A `toHaveURL` wait is therefore no render barrier: the DOM can still show the previous state.

During the 2026-10 deps upgrade, a keyboard-regions flake ("list region briefly unmounts on Chromium 156") was blamed on the browser. The real cause was that the test's first filter click emptied the list (an empty state with no list region), and `not.toHaveURL` passed before the second click's render committed.

**Why:** a misattributed root cause leads to wrong follow-up tickets and comments that mislead later readers.
**How to apply:** when an e2e fix says "briefly absent/unmounted after a URL change," check whether the prior UI state already lacked the element. The barrier has to be a DOM assertion (`expect.poll` / `toBeAttached`), not the URL.
