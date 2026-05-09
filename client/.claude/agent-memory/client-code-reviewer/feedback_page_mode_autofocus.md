---
name: Page-mode autofocus competition
description: When the page chrome of the universal item editor suppresses one autofocus, audit the rest of the body for other autofocusing fields that re-create the same complaint.
type: feedback
---

The page-mode UX overhaul removed `autoFocus` from the title for the stated reason "long titles pin the cursor at the end and scroll the start out of view." Reviewer should then audit the rest of the page-mode JSX for any field with `autoFocus` (or equivalent imperative focus call) that fires unconditionally on mount — those re-create the exact same problem from a different field.

In the page-mode notes overhaul, the click-to-edit textarea shipped with unconditional `autoFocus`. When notes were empty, `pageNotesEditing` initialized to `true`, so the textarea grabbed focus on initial page load — the same complaint just shifted one field down.

**Why:** This pattern (suppress one autofocus, accidentally enable another) is easy to miss on a focused diff that only mentions the title field in the prompt.

**How to apply:** Whenever a diff says "removed autoFocus from X for read-mostly pages," grep the same component for `autoFocus`, `focus()`, and `useRef` + `.focus()` calls. Flag any that fire unconditionally on mount; recommend gating on "user gesture brought us here" (e.g. a ref set during click handler).
