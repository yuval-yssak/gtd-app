---
name: gcal-403-rate-limit-is-retryable
description: "Google's per-user write quota is HTTP 403 (not 429) with reason rateLimitExceeded/userRateLimitExceeded — categorizeGCalError must bucket it transient_exhausted, and the same predicate silently governs rsvpReplay's retryWithBackoff"
metadata:
  type: project
---

Google Calendar's short-window per-user write quota surfaces as **HTTP 403, not 429**, carrying
`errors[].reason` of `rateLimitExceeded` / `userRateLimitExceeded` and message "Rate Limit
Exceeded". googleapis throws it in two observed shapes: with the structured `errors` array
populated, and as a bare GaxiosError with only `message` set — a categorizer must check both.

**Why:** `categorizeGCalError` bucketed all 403s as `terminal`, which renders the SyncIssuesPanel
row Dismiss-only. During the 2026-08-19 burst-trash incident that would have told the user a
self-clearing throttle was permanent.

**How to apply:** two non-obvious couplings to re-check whenever this function changes.
1. `rsvpReplay` builds its `retryWithBackoff` predicate as
   `(err) => categorizeGCalError(err) === 'transient_exhausted'`. Widening the transient bucket
   therefore silently changes RSVP *retry* behavior too, not just panel affordances. Backoff is
   1s/5s/24s, which is appropriately spaced for a quota — but confirm the budget still suits any
   newly-transient class before widening.
2. `RETRYABLE_REASONS` in `routes/syncIssues.ts` mirrors the panel's UX contract and the client's
   failure-label map. A new `OpFailureReason` needs all three updated.

Do NOT extend the predicate to `dailyLimitExceeded` / `quotaExceeded` by reflex — those are
long-window and a Retry button on them is a lie.

Related: [[project_gcal_pushback_failure_surfacing_coverage]].
