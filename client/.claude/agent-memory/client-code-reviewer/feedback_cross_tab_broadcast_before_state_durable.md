---
name: feedback-cross-tab-broadcast-before-state-durable
description: Cross-tab "X happened, reload" broadcasts get sent before the sender finishes the IDB pointer + cookie writes the receivers' reload depends on
metadata:
  type: feedback
---

When a flow both broadcasts to other tabs (localStorage `storage` event) and then does slow
follow-up writes (push unsubscribe with a 2 s deadline, `setActiveAccount`, `multiSession.setActive`),
the broadcast tends to sit right after the first write. Receivers react by reloading, and their
boot reads the IDB active pointer / session cookie that the sender has not written yet — they land
on the public `/` landing page or bounce to `/login` while a survivor account exists. Single-account
e2e cases cannot see it (both tabs go to `/login` regardless).

**Why:** Round-5 account-deletion review (2026-10-04): `evaporateAndRecoverOnce` broadcast before
`unsubscribePushBestEffort` + `pivotToAccount`; earlier rounds only checked the receivers agreed on
a destination, not that the state behind the destination existed yet.

**How to apply:** For any broadcast that triggers a reload elsewhere, check the sender's write order:
broadcast must follow every write the receiver's boot path reads. Ask for a multi-account two-tab
case or an order assertion (broadcast after setActive). Related: [[feedback-fallback-navigation-clobbers-specific-one]].
