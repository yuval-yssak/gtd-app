---
name: e2e-repeat-click-races-transition-gate
description: Fixed-count `for` loops clicking `.first()` on a transition-gated (disabled while isMutating) row control race the commit; assert the shrinking count each iteration
metadata:
  type: feedback
---

E2E loops of the form `for (let i = 0; i < N; i++) await page.getByTestId('removeXButton').first().click()`
are ambiguous whenever the host dialog gates its controls behind `useTransition`
(`disabled={isMutating}`). Each click opens a window where all buttons are disabled and the row list
has not re-rendered, so `.first()` can re-resolve to the SAME row and one entity survives — surfacing
later as an opaque final-count mismatch rather than at the bad click.

**Why:** `ManageInboxesDialog` deliberately transition-gates add/move/remove because those handlers
compute positions from the rendered list, so a second click against stale indices scrambles `order`.
The e2e that first covered its remove path clicked three times in a bare loop and asserted
`toHaveCount(0)` only at the end. Playwright's actionability wait usually saves it, but the disabled
state is applied asynchronously AFTER the click, so a stale-row dispatch is reachable.

**How to apply:** whenever an e2e repeats a click on a list-row control, check the component for a
`useTransition`/`isMutating`/`isPending` disable. If present, make each iteration self-synchronising:
```ts
for (let remaining = N; remaining > 0; remaining--) {
    await page.getByTestId('removeXButton').first().click();
    await expect(page.getByTestId('manageXRow')).toHaveCount(remaining - 1);
}
```
This forces a commit between clicks and fails at the exact bad iteration. Also flag when the test's
own comment claims PERSISTENCE ("never re-seeded", "survives reload") but the assertions never
reload — the render is proven, the durability is not; and any such reload needs `gtd.flush` first
(see [[feedback_e2e_goto_mid_flush_lock]]).
