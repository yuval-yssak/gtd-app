---
name: snackbar-host-lifecycle
description: Per-route Snackbar surfaces only work when the action that fires the toast does NOT also unmount the host (route navigate / wizard advance-past-last). Watch for this on any "warn user, then close" flow.
metadata:
  type: feedback
---

When a mutation fires a Snackbar message via an `onX` callback, then immediately runs a path
that unmounts the Snackbar's host (route navigate, wizard "step done" branch, dialog close that
removes the parent), the toast opens in state but never renders — the user sees nothing.

This is a recurring gotcha in this codebase because the dominant Snackbar pattern is *per-route*
(`calendar.tsx`, `inbox.tsx`, etc. each mount their own `<Snackbar>` outside the editor). It
works for `useItemEditor`-driven surfaces because closing the editor (dialog/popover/expand)
does NOT unmount the route. It fails for:
- `routes/_authenticated/item.$itemId.tsx` — `onClose` navigates away.
- `ProcessInboxWizard` — last-item save flips `step.kind` to `'done'`, short-circuiting
  before the Snackbar mount point.

**Why:** Concretely surfaced during the fromGmail-readonly snackbar review (May 2026). The diff
added local Snackbar mounts to both surfaces, but the save success path of those surfaces is
exactly the path that unmounts those Snackbars.

**How to apply:**
1. When reviewing any "open toast, then close/navigate" flow, trace whether the close path
   unmounts the Snackbar's host.
2. Mitigations:
   - Hoist the Snackbar to a layout that survives the navigation (e.g. `_authenticated.tsx`).
   - Move the Snackbar outside the early-return branch in wizards (so it persists when
     `step.kind === 'done'`).
   - Replace the Snackbar with an inline acknowledgement (Alert in editor body) that the user
     dismisses before the save advances.
   - Delay the close/navigate until after `autoHideDuration` elapses (last resort — couples
     navigation to UI timing).
3. The `useItemEditor` Snackbar pattern is robust because the editor closes but the route
   stays. Don't assume the same is true for routes that ARE the editor surface.
