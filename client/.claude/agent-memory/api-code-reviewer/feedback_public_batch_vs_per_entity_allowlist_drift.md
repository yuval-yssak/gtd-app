---
name: public-batch-vs-per-entity-allowlist-drift
description: Snapshot-based /v1/operations/batch guards drift from per-entity PATCH allowlists — diff the field sets, and use the read-projection criterion to pick the denylist
metadata:
  type: feedback
---

When a change adds field-level guards to a **snapshot-taking** endpoint (`/v1/operations/batch`)
and the comment says it "mirrors the per-entity routes' allowlists", do not take that at face
value. Mechanically diff three sets:

1. the Zod snapshot schema's field list (what the endpoint structurally accepts),
2. the per-entity route's `PATCH_WRITABLE_FIELDS` / `checkWritableKeys` allowlist,
3. the new denylist on the batch route.

**Why:** the two guards are opposite in polarity. Per-entity routes use an **allowlist** (closed
by default). A batch denylist is **open by default** — every field not listed is writable, and
fields added later are automatically writable. A hand-written denylist reliably under-covers.

**Resolution pattern that was accepted here (2026-08-27 LWW review):** deriving the denylist from
the PATCH allowlist is NOT the right fix on this codebase — it would 400 honest MCP callers,
because `routineExceptions` / `lastGeneratedDate` / `splitFromRoutineId` are server-managed yet
sit in `presentRoutine`'s `PUBLIC_FIELDS`, so a legitimate `gtd_get_routine` echo carries them.
The accepted criterion is: **deny every sync-integrity anchor that the public read projections
(`presentItem` / `presentRoutine`) never expose** — echo-safe by construction, since no honest
round-trip can trip it. Verify it mechanically: no denied field may appear in `PUBLIC_FIELDS`.

**Residual to expect and accept:** GCal display-mirror fields (`organizer`, `creator`, `attendees`,
`responseStatus`, `eventType`, `meetingLink`, `location`, `htmlLink`, `allDay`) stay writable.
They are absent from the projections but are reasserted on the next inbound pull, so they are a
different risk class from unique-index keys (`calendarInstanceEventId`) or heal-suppressors
(`retiredByGCal`). Note `responseStatus` is read as `priorResponseStatus` in `rsvpReplay.ts` —
a narrow window of influence, flagged non-blocking.

**How to apply:** when the guarantee ends up narrower than PATCH's, require that the code comment
STOP claiming parity, state the actual criterion, and list the deliberate exclusions with reasons —
and that `PUBLIC_API.md` document the asymmetry. Check BOTH doc passages: the per-entity field
overview and the batch section drift apart easily.

Related: [[feedback_op_snapshot_is_not_the_stored_row]], [[feedback_response_reflects_persisted_state]].
