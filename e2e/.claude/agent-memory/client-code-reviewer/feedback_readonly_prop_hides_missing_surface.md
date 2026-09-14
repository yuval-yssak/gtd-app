---
name: readonly-prop-hides-missing-surface
description: A new `readOnly` prop justifies itself by pointing at "the proper editor" — verify that editor actually renders the affordance; often it does not exist.
metadata:
  type: feedback
---

When a shared editor component gains a `readOnly` (or `disabled` / `compact`) prop, the doc
comment routinely justifies the removal with "editing X belongs in <the other editor>".
**Grep the named editor for the affordance before accepting the rationale.** In the routine
review card case, `MeetingDetails.readOnly` said attendee edits "belong in the routine editor" —
`components/routineEditor/RoutineEditorBody.tsx` renders no attendee UI at all and only
`delete updated.attendees`. So the affordance is unreachable everywhere, not relocated.

Two companion smells that travel with the same prop:

- **Required callbacks satisfied by no-ops.** `onRsvp={noopAsync} onAttendeesChange={noopAsync}`
  keeps the prop type honest but makes "never called" a comment rather than a type guarantee.
  A discriminated union (`{readOnly: true} | {readOnly?: false; onRsvp; onAttendeesChange}`)
  makes the compiler enforce it and deletes the dead lambdas.
- **The read-only branch re-implements the interactive child.** A parallel `Xreadonly` list that
  copies the chip's color/variant/person-check/tooltip diverges immediately (here: `✓`
  escape vs the literal `✓`, plus a brand-new `sx={{fontWeight:600}}` self-emphasis the editor
  chip does not have — and `sx` for appearance violates the CSS rules in client/CLAUDE.md).
  The fix is one `interactive`/`onRemove?` flag on the existing chip.

**Why:** the prop reads as a scoping decision, so reviewers debate the policy instead of
checking the policy's premise and the duplication it introduces.

**How to apply:** for every new `readOnly`-style prop — (1) grep the "proper place" named in the
comment, (2) check whether required callbacks became no-ops instead of the prop type splitting,
(3) diff the new passive renderer against the interactive one line by line.

Related: [[feedback_inline_reimplementation_of_existing_sibling_component]],
[[feedback_extracted_body_diverges_from_shared_chrome_type]]
