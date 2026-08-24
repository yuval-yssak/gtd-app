---
name: testid-constant-lists-untethered-from-render
description: Module constants listing data-testid strings (focus-restore primaries, scroll anchors) get unit-tested through a fake lookup, so a rename in the rendering component degrades them to a silent no-op that no test catches
metadata:
  type: feedback
---

When behaviour is driven by a hardcoded list of `data-testid` strings — e.g.
`PRIMARY_ACTION_TEST_IDS = ['stageContinue', 'clarifySaveNext', 'focusKeep']` picking a focus
fallback — the unit tests inevitably feed that constant through a structural fake. They then pass
unchanged after someone renames the testid in the component that actually renders it, and the
feature degrades to "resolves to null / does nothing" with no failure anywhere.

**Why:** the constant and the JSX that must agree with it live in different files with no type
relationship, and testids are exactly the kind of string a refactor renames freely. Partial e2e
coverage hides it further: some entries in the list usually happen to be covered as *received*
targets while others (in the weekly review, `clarifySaveNext`) are only ever covered as things
being clicked.

**How to apply:** when reviewing a diff that introduces a testid-string constant, check each entry
for a test that asserts it is *received*, not merely used. Ask for either a unit test asserting the
constant against the rendering sources, or one e2e assertion per entry. Also verify test-id lists
against the possibility that the same testid renders twice simultaneously (in this codebase the
reassign-blocked fallback and the portaled editor row both render `stageNavBack`-style ids —
`querySelector` silently takes the first in document order). Related:
[[conditional-render-gate-loses-coverage]], [[fixed-critical-ships-without-its-e2e]].
