---
name: hide-field-seed-empty-clears-silently
description: Hiding a form input by seeding its state '' turns the diff-patch into a silent clear of prior server data; require a regression test.
metadata:
  type: feedback
---

When a change hides a form field (e.g. WaitingFor drops the `Ignore before` tickler input) by seeding that field's state to `''` on mount instead of `item.<field> ?? ''`, the in-place edit path becomes a silent **clear**: `buildEditPatch`/`addXPatchFields` compares `'' !== (item.field ?? '')` and emits `patch.field = ''` for any item that previously held a value. The status-transition path (`applyXForm`) likewise strips it via the `...(form.field ? {...} : {})` spread.

It is self-consistent across both save paths, but it is a behavior change on existing data and the single highest-risk part of such a diff. The WaitingFor case turned out to be a **bug**, and the field was restored on 2026-09-25: the API/MCP still wrote `ignoreBefore` on waitingFor, and waitingFor is in `TICKLER_STATUSES`. Snoozed waiting items therefore showed on /tickler with an invisible date that any editor save wiped. Before approving a hidden field, check whether another writer (public API, MCP, sync) can still set it, or whether a list page still filters on it. If either is true, hiding it strands the data. Request Changes rather than accepting the silent clear.

**Why:** the clarify forms (`components/clarify/types.ts`, `editItemDialogLogic.ts`) already have thorough per-field diff/merge tests, so a reviewer can be lulled into thinking the hidden-field case is covered. It is not — existing tests seed `emptyWaitingFor` (ignoreBefore already `''`), so they never exercise "item HAD ignoreBefore, form seeds empty, edit clears it."

**How to apply:** whenever a diff hides an input and seeds its state empty, require two Vitest cases against the logic layer (not the component): (1) `buildEditPatch` on an item that already had the field emits `patch.field === ''` (the clear), and (2) `mergeFormsIntoItem`/`applyXForm` on such an item omits the field. Confirm the *other* status that keeps the field (somedayMaybe here) still has its keep-the-value test. Also flag any storybook `filled*` mock that still sets the now-hidden field — it renders nothing and misleads.
