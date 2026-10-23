---
name: unvalidated-order-key-poisons-minting
description: Server-side minting that derives a new key from a stored client/batch-supplied key (fractional-indexing rank) throws for the whole account if one stored key is malformed
metadata:
  type: project
---

`ItemInterface.rank` is validated only as `nonEmptyString`, but `topRankForUser` feeds the user's LOWEST stored rank into `generateKeyBetween`, which throws on any invalid key ('0', '!', 'A', 'a00'). Uppercase/digit-led junk sorts lowest, so one bad row from `/v1/operations/batch` or `/sync/push` makes every later POST /v1/items, bulk import, routine nextAction generation and PATCH-into-nextAction 500 for that user. (Found 2026-10-23, next-actions-rank review.)

**Why:** "derive from the extreme stored value" turns one bad row into an account-wide outage — same blast-radius shape as the GCal E11000 sync freeze ([[gcal-series-collision-family]]).
**How to apply:** for any field the server later computes from (keys, cursors, rrules), require a schema refine that runs the same parser the consumer runs, plus a defensive fallback in the consumer. Check whether the client mirror has the same exposure.
