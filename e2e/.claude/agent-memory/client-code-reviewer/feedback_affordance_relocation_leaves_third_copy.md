---
name: affordance-relocation-leaves-third-copy
description: Moving a small affordance between host header and shared body oscillates across commits; each swing leaves a stale comment in the host that did NOT change and re-grows an already-3x-duplicated PageHeader
metadata:
  type: feedback
---

The item-ID copy button has now moved **host header → shared body → host header** across two
commits. Each swing has the same two blind spots:

1. **Stale "why not here" comments in the hosts that did NOT change.** When the button was
   consolidated into `ItemEditorBody`, an identical comment (`No header CopyIdButton:
   ItemEditorBody's bottom meta row owns the ID + copy now.`) was pasted into all three headers.
   The reversal only edits the two hosts being reverted — the third (`ProcessInboxWizard`'s
   `WizardHeader`) keeps a comment that now asserts something false about a global invariant.
   **How to apply:** `grep` the exact comment text of any "we deliberately don't render X here"
   note. If the diff changes the premise, every copy of that comment is now a lie, including the
   ones in files outside the diff.

2. **Restoring the header button re-grows a verbatim `PageHeader` triplet.** `item.$itemId`,
   `routine.$routineId`, `person.$personId` each own a byte-identical local `PageHeader`
   (`{title, onBack, idForCopy?}` + back arrow + flex-1 title + `{idForCopy && <CopyIdButton/>}`)
   and byte-identical `.header`/`.headerTitle` CSS blocks *including the same explanatory comment*.
   The diff adding `idForCopy?` to the item page reads as a 2-line prop addition; it is actually
   the third instance of the pattern. CLAUDE.md "Abstraction" (2+ occurrences → extract) applies to
   the whole trio, not to the diff in isolation.

**Why:** the reviewer's attention is anchored on the two files that changed, and the invariant the
comment encodes ("exactly one copy affordance per screen") is enforced by convention across five
hosts with nothing linking them.

**Note on the a11y false alarm:** a `CopyIdButton` inside `DialogTitle` does **not** break
`getByRole('dialog', { name: 'Edit item' })` — that combination shipped green at cc2c039. Don't
flag it; verify against git history instead of reasoning about accname-from-content.

Related: [[inline-reimplementation-of-existing-sibling-component]],
[[extracted-body-diverges-from-shared-chrome-type]].
