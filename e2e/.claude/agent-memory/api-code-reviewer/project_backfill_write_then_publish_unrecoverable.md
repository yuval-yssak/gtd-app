---
name: backfill-write-then-publish-unrecoverable
description: One-off backfill scripts that bulkWrite rows then insert ops in a separate step, with idempotency keyed on the written field, cannot recover from a publish failure on rerun
metadata:
  type: project
---
Backfill scripts (e.g. backfillItemRanks) write the DB first, then re-read and publish ops in a later step. Their idempotency check is "field already present → skip". When ops insert/notify fails after the write, a rerun sees the field and skips the row, so no op is ever published and devices never learn the change.

**Why:** spotted 2026-10-23 on the open-list rank pass (pass 5), where `--force` does not cover the pass. The nextAction pass can only be repaired through `--force`. Atlas M0 quota write-blocks have hit this project before (see staging quota memory), which makes a failure between the two steps realistic.

**How to apply:** for every write-then-publish backfill, ask what a rerun does after a crash between the steps. Push for one of: a rollback of the unpublished writes, a republish/force mode, or per-chunk write+publish together with logging of the exact range.
