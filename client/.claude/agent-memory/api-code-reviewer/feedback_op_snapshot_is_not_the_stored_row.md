---
name: op-snapshot-is-not-the-stored-row
description: Response fields read off op.snapshot are the *attempted* write, not the persisted row — wrong whenever apply was skipped or the snapshot was hydrated
metadata:
  type: feedback
---

Any API response field derived from `op.snapshot` after `applyAndPublishOperation(s)` describes
the **op that was attempted**, not the row that is now in Mongo. Verify the two agree before
labelling such a field "authoritative" in docs or MCP tool descriptions.

**Why:** two mechanisms break the equivalence in this codebase, and both are invisible at the
call site:

- **Skipped applies.** `applyEntityOp` returns `skipped_stale` / `skipped_missing` /
  `skipped_duplicate_key` — the op is still built and logged with a full snapshot, but the
  collection was never touched. Reporting `op.snapshot.updatedTs` alongside a `skipped_*` status
  hands the caller a timestamp that matches nothing in the DB. Agent callers cache and re-echo
  those values.
- **In-place hydration.** `hydrateDeleteSnapshots` / `hydrateCalendarDetachSnapshots` mutate
  `op.snapshot` *before* the route reads it, so a delete op's snapshot is the pre-delete row
  carrying the **client's** old timestamp — even on a server-stamping path where the docs claim
  the value is server-assigned (or `null`).

**How to apply:** for any per-op result payload, either (a) gate the field on
`applyStatus === 'applied'` and emit `null` otherwise, or (b) re-read the row. Empirically probe
the delete and skipped paths rather than reasoning from the happy path — a scratch test that
asserts `expect(JSON.stringify(body)).toBe('REVEAL')` surfaces the real value fast, since vitest
suppresses `console.log` here.

Related: [[feedback_response_reflects_persisted_state]].
