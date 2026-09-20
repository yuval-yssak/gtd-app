---
name: stale-invariant-doc-after-deliberate-exception
description: When one case of a switch/dispatch gains a deliberate exception, the FUNCTION-level doc comment asserting the old universal invariant is left stale — the new comment goes only at the case site.
metadata:
  type: feedback
---

When a change makes one branch of a switch/dispatch deliberately diverge from a rule the
whole function's doc comment states universally, the author reliably writes an excellent
case-site comment explaining the exception **and forgets the function-level doc comment**,
which keeps asserting the now-false invariant.

Seen on `stageEligibleItems` (weekly review): the header said every stage walks its page's
order *"in that page's default view"*, while the `waitingFor` case deliberately switched to
the page's non-default "By date" view. The case comment was thorough; the header was not
touched.

**Why:** these doc comments are the contract future stage authors read when adding a case —
a stale universal claim actively teaches the wrong rule, and the exception is exactly the
thing that needed to be discoverable from the top. This codebase invests unusually heavily
in explanatory comments, so a stale one is more misleading here than in a sparser repo.

**How to apply:** whenever a diff adds a "DELIBERATE divergence" / "unlike the others" comment
inside one case, scroll up to the enclosing function's JSDoc and check whether it states the
rule being broken. Same check for any shared comparator/helper whose header claims "shared by
X and Y so both stay identical" when a third caller now diverges. Cheap to verify, and it is
a documentation-only fix so it never blocks approval on its own. Related:
[[inverse-pair-predicates]].
