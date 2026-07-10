---
name: show-button-calls-toggle
description: One-way "Show/Enable X" action buttons wired to a toggle helper can re-hide/disable when state changed underneath; require a direction guard.
metadata:
  type: feedback
---

A UI action with one-way intent ("Show account", "Enable X") that calls a symmetric `toggleFoo(id)` helper is a latent bug: if the underlying state was flipped by another surface (e.g. the AccountVisibilityToggles avatar row, or a cross-tab storage bridge) while the affected UI (a Snackbar/toast) is still open, clicking the one-way button flips the *now-correct* state back to wrong.

**Why:** the hidden-accounts store (`contexts/hiddenAccounts.ts`) exposes only `toggleAccountHidden` (hidden ⇄ shown). The inbox "Show account" Snackbar action called it unconditionally, so with the snackbar still open after the user un-hid the account elsewhere, the button re-hid it. This is the [[inverse-pair-predicates]] smell applied to actions rather than predicates.

**How to apply:** when a "show/enable/close" button intends one direction, require the caller to read current state and only toggle when needed — e.g. `if (getHiddenAccountIds().includes(account.id)) toggleAccountHidden(account.id)`. Flag any one-way-labeled control wired straight to a `toggle*` helper, and ask for a test that clicks it when already in the target state (should be a no-op). Same applies to the negative branch of the trigger condition (action not hidden → no toast).
