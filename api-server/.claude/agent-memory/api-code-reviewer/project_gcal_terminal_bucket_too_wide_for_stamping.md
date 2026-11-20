---
name: gcal-terminal-bucket-too-wide-for-stamping
description: categorizeGCalError 'terminal' includes daily-quota / quotaExceeded / insufficientPermissions 403s — reusing it for "stop retrying forever" decisions silently drops recoverable pushes
metadata:
  type: project
---

`categorizeGCalError` was designed for SyncIssuesPanel UX (Retry vs Dismiss-only). Its `terminal`
bucket deliberately includes every non-short-window-rate-limit 403 — `dailyLimitExceeded`,
`quotaExceeded` ("Calendar usage limits exceeded"), `insufficientPermissions` — because a Retry
button would mislead. Those clear on their own (next day / after re-consent).

Seen 2026-11-20 in the fromGmail 400-loop fix: the missed-push sweep stamped `lastPushedToGCalTs`
on any `terminal` failure, which would permanently hide quota-403'd rows from the sweep until a
manual edit — when the panel's Dismiss-only is a visible row, the sweep stamp is invisible.

**Why:** the panel can afford "terminal" to be wide (the user still sees the row); a silent
"never retry" decision cannot.

**How to apply:** whenever a new caller turns `terminal` into an automatic, invisible
give-up (stamp, skip, delete, revert), check whether it needs a narrower predicate that
excludes quota/scope 403s. Related: [[gcal-deterministic-instance-id-patch]].
