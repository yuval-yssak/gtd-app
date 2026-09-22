---
name: e2e-asserts-textcontent-for-visual-bug
description: Specs for clipping/truncation/overflow bugs assert toHaveText/toHaveValue, which read textContent and pass with the bug fully present
metadata:
  type: project
---

Specs written to prove a *visual* defect (text clamped to one line, content clipped, element
overflowing) reliably include at least one assertion of the form
`await expect(el).toHaveText(LONG_STRING)` or `toHaveValue(LONG_STRING)`. Those read
`textContent` / `.value`, which are unaffected by `overflow: hidden`, `white-space: nowrap`,
`-webkit-line-clamp`, or a single-line `<input>` scrolling sideways. The assertion passes
identically before and after the fix.

**Why:** the author verifies the spec by temporarily removing the fix and confirming the suite
goes red — but only *one* assertion in the file actually flips, and the tautological ones ride
along inside the same green run. The failure is invisible unless each assertion is checked
individually. A sibling symptom: asserting against an element that already wrapped before the
change (a `Typography` with no `noWrap`), so the test covers a path the bug never touched.

**How to apply:** for any spec justifying a layout/overflow/clamping fix, classify every
assertion as *geometric* (`scrollHeight`/`clientHeight`, `scrollWidth`/`clientWidth`,
`boundingBox()`, `toBeInViewport()`) or *textual*. Textual ones are presence checks, not
evidence — say so explicitly and name which assertion is load-bearing. Ask the author to
re-verify by disabling the fix and confirming *that specific* assertion fails, not just the
file. Related: [[e2e-picker-visibility-not-selection]],
[[testid-constant-lists-untethered-from-render]].
