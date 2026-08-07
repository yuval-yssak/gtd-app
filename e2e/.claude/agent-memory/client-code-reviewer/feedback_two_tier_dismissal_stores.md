---
name: two-tier-dismissal-stores
description: When a warning gains a second, louder surface (dialog on top of banner), the module store grows parallel dismissal tiers — check the unmount-time acknowledge and the "flagged but unknown account" filter.
metadata:
  type: feedback
---

When an existing warning surface (banner) gains a second, louder surface (blocking dialog) backed by the same module store, the store grows a second, weaker dismissal set (e.g. `dialogAcknowledgedUserIds` alongside `dismissedUserIds`). Two recurring gaps in this shape:

1. **Acknowledge is driven off the rendered list, not the flagged list.** The dialog's "Not now" handler loops over the accounts it *rendered* (flagged ∩ locally-known). Any userId that is flagged but not yet present in the async-loaded account list is never acknowledged, so the dialog re-opens by itself moments later when that account finishes loading. Acknowledge the raw flagged ids from the store, not the filtered view list.
2. **A flagged-but-unknown account renders nothing at all.** Both surfaces filter to accounts known locally so they can show an email. If the account list hasn't loaded (or the account was removed), the loud warning silently degrades to no warning — the exact failure mode the dialog exists to prevent.

**Why:** the whole point of the escalation is that the silent-stale-data state must never go unnoticed; a filter that can empty the list re-introduces silence, and an acknowledge keyed on the filtered list makes dismissal non-sticky.

**How to apply:** on any review touching `contexts/*Events.ts` two-tier stores or their dialog/banner consumers, trace (a) which list the dismiss/acknowledge handler iterates, and (b) what renders when the flagged id is absent from the account list. Related: [[cross-tab-bridge-install-in-render]].
