---
name: new-lib-module-ships-untested
description: New pure-logic modules under client/src/lib/ arrive with e2e-only coverage even though every existing lib module has a direct unit test
metadata:
  type: project
---

When a UI fix needs a small pure helper, the author extracts it to `client/src/lib/<name>.ts`
and covers the *behaviour* with a Playwright spec, leaving the module itself without a Vitest
test. The stated reason is "the client has no RTL/component tests, so this fix is e2e-only" —
but the extracted helper is plain logic, which is precisely the tier the 143 files in
`client/src/tests/` do cover.

**Why:** a mechanical check settles it — every single `client/src/lib/*.ts` module is imported
by at least one file in `client/src/tests/`. A new lib module with no test is therefore an
objective break in an otherwise complete pattern, not a judgement call about testing philosophy.
The e2e spec typically exercises only the one path the bug report mentioned (e.g. a typed
newline), leaving the helper's real risk surface — regex/`\r`/CRLF/unicode-separator edge cases,
idempotence, whitespace preservation — entirely unexercised.

**How to apply:** when a diff adds a file under `client/src/lib/`, run
`for f in client/src/lib/*.ts; do b=$(basename "$f" .ts); grep -rqln "lib/$b'" client/src/tests || echo "$b"; done`
before writing the Test Gaps section. If the new module is the only output, cite it as a
standards violation ("Tests" in root CLAUDE.md) rather than a suggestion, and enumerate the
input classes the e2e path cannot reach. Do not accept "the client has no component tests" as
covering a lib-level extraction. Related: [[no-dom-hook-test-gap]],
[[sync-flags-unit-test-gap]].
