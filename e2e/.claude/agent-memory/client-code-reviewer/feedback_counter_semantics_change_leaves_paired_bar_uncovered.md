---
name: counter-semantics-change-leaves-paired-bar-uncovered
description: When a header "n of m" counter's numerator is redefined, the LinearProgress percentage computed from the same numerator ships with no test exercising the newly-included term — every existing bar assertion sits in the old-semantics case
metadata:
  type: feedback
---

`stageItemProgress`-shaped helpers return BOTH a `label` ("2 of 12") and a `value` (percentage) from
one numerator. When the numerator is redefined (e.g. `decisions.length` → `decisions.length + cursor`),
the diff updates both consumers correctly, and the label gets fresh unit + e2e assertions — but every
pre-existing `aria-valuenow` assertion on the bar happens to be recorded in a state where the newly
added term is **zero**, so the bar half of the change is asserted only in the case where old and new
semantics coincide.

The label and the bar are the same expression, so the risk is low — but the coverage claim
("both the label and the bar now use the new count") is not actually pinned by any test.

**Why:** the counter is what the bug report names, so the author's test-writing attention goes to
the text. The bar is treated as a derived detail rather than a second rendered assertion. The pre-existing
bar assertions were written for a different scenario (header collapse/expand stickiness) and were never
re-read for numerator relevance.

**How to apply:** on any diff changing what a progress numerator counts, grep the e2e spec for
`aria-valuenow` / `progressbar` and check whether ANY existing assertion sits in a state where the
newly-included term is non-zero. If they are all in the coinciding case, ask for one bar assertion
taken after the new term alone moves (e.g. after a skip, before any decision).

Also worth checking on these diffs: whether existing counter assertions elsewhere in the spec that
were left UNCHANGED are correct on purpose or merely coincidentally equal (cursor === 0 states).
Say which, so the "verified, suite passes" claim is understood correctly.

Related: [[count-label-scope-narrowing]], [[conditional-render-gate-loses-coverage]],
[[lifted-helper-leaves-original-test-home]]
