---
name: sidecar-write-bypasses-owner-marker
description: A denormalised marker on items that encodes "state of the itemBriefs sidecar" is only maintained by item writes — sidecar-only writes (authored brief PUT, brief clear) bypass the DAO choke point entirely
metadata:
  type: project
---

`items.briefStale` is stamped by `ItemsDAO` overrides, which makes it unbypassable for writes to
`items`. But the predicate it encodes is about the **`itemBriefs` sidecar**, and the sidecar lives
in a different collection with a different DAO. Any write that changes the sidecar without touching
the item slips past the choke point completely.

**Why:** found on re-review 2026-09-21. `PUT /v1/items/:id/brief` with `{"brief": null}` →
`clearBrief` deletes the row and touches nothing on `items`; a settled item (`briefStale: false`)
is left with no brief and no marker, i.e. permanently invisible to the sweep — the exact "false
`false` strands an item forever" failure the module exists to prevent. Same shape for
`writeAuthoredBrief` (pin → unpin makes a previously-excluded item targetable again without an
item write). Both reachable from the client editor and MCP `gtd_set_brief`.

The two `cascadeItemBriefRemoval` call sites are NOT holes, for a reason worth remembering: the
reference cascade fires only on item delete (item is gone), and reassign does its
`applyAndPublishOwnerMove` (→ `replaceByOwner` → marks) BEFORE deleting the source brief. Ordering,
not design, is what saves them — so a reordering there would open the same hole.

**How to apply:** whenever a denormalised flag on entity A encodes a fact about sidecar B, enumerate
writers of B, not just writers of A. Grep the sidecar's DAO and its lib module for the marker name;
zero hits on a write path that mutates B is the smell. Fix is to mark from the sidecar writer too.
Related: [[denormalised-marker-read-clear-race]], [[brief-declined-state-split]] (same feature, same
habit of splitting one fact across surfaces).
