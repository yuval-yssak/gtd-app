---
name: shared-dialog-refresh-gap
description: When a person/item/workContext edit dialog gets extracted for reuse across multiple call sites, the caller-supplied onSaved closure tends to omit the refreshXxx() call. Check every call site refreshes IDB → React state.
metadata:
  type: feedback
---

When an edit dialog (PersonEditDialog, etc.) gets refactored out of a route for reuse, the new
shared component delegates "what to do after save" to the caller via `onSaved`. The route caller
typically remembers to `await refreshPeople()` (it was there originally), but secondary call sites
(e.g. MeetingDetails launching the dialog from an attendee chip) routinely forget — they just
close the dialog (`setTarget(null)`) without invalidating React state.

The symptom is subtle: the IDB write + sync op queue both succeed, the server eventually pushes
the change back via SSE and the UI converges. But until that SSE round-trip, the local state is
stale — chip labels show the old name, autocompletes show the old email, etc.

**Why:** Repeated pattern observed during the PersonEditDialog extraction (May 2026). The /people
route's `onEditSaved` correctly refreshed; MeetingDetails' caller did not. This is exactly the
class of bug `client/CLAUDE.md` "Mutation pattern in routes" is trying to prevent — but extracted
dialogs invert the contract by delegating the refresh out to opaque caller closures.

**How to apply:** Whenever reviewing a shared edit/mutation dialog with a callback-style API:
1. Grep every call site for the dialog. For each, check the `onSaved` (or equivalent) closure
   actually calls the relevant `refreshXxx` from `useAppData()`.
2. Recommend the refresh live INSIDE the dialog (next to the mutation), not in the caller's
   closure. `QuickCreatePersonDialog` already does this — it's the right shape.
3. If the dialog can't always know which scope to refresh (e.g. it's used for both items and
   people), accept the trade-off and require a `refresh: () => Promise<void>` prop with a comment
   spelling out the contract.

Related: [[ idb-mutation-pattern ]] (concept from CLAUDE.md, no separate memory needed).
