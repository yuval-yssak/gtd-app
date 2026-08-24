---
name: parity-pin-tests-for-known-gaps
description: For pre-existing gaps a new entity inherits (e.g. replaceById tenant bypass), request a PARITY PIN test asserting current behaviour with a comment saying it should flip when fixed.
metadata:
  type: feedback
---

When a new entity inherits a known, pre-existing defect (rather than introducing one), do not
demand the fix as a merge blocker — ask for a **parity pin** test: assert the CURRENT
behaviour, with a comment stating it is pinning actual-not-desired behaviour and should flip
when the real fix lands.

**Why:** on the `reviewInbox` review (2026-08-23) I empirically confirmed a cross-tenant
clobber (Bob pushing a foreign `entityId` steals the row — `replaceById` upserts by `_id`
alone). It is identical for item/routine/person/workContext, so blocking a new entity on it
would be scope creep, but leaving it silently untested lets the gap widen invisibly. The
author accepted the pin readily; it made the gap legible without derailing the feature.

**How to apply:** validate a parity pin by simulating the future fix, not the current code —
I scoped `replaceById` by owner in a throwaway edit and confirmed the pin test (and only that
test) flipped to failing. A pin that does not flip under the prospective fix is worthless.
Distinguish clearly in the review between "new regression" (blocking) and "inherited parity"
(pin + note). Related: [[feedback-verify-tests-discriminate-by-stashing-source]],
[[project-replaceById-tenant-bypass]].
