# Case A8 — Complete a single instance (calendar routine)

**Read first:** `gcal-sync-smoke-case-shared-preamble.md`.
**Matrix section:** A8.

## Setup
Create a fresh weekly calendar routine `e2e-smoke-A8-<ts>` with **today's day-of-week** as the only BYDAY (e.g. if today is Wed, pick Wed only). Defaults: 09:00 start, 60m duration, never ends. This guarantees today gets a generated `calendar` item even if 09:00 has already passed wall-clock.

After creation, wait ≤30s and verify baseline in mongo (read-only):

```bash
mongosh "mongodb://127.0.0.1:27017/gtd_dev" --quiet --eval '
const r = db.routines.findOne({title: "<routine-title>"});
print("ROUTINE:", JSON.stringify({_id: r?._id, active: r?.active, calendarEventId: r?.calendarEventId, routineExceptions: r?.routineExceptions ?? null}));
const items = db.items.find({title: "<routine-title>"}).sort({timeStart: 1}).toArray();
print("COUNT:", items.length);
items.forEach(i => print(JSON.stringify({_id: i._id, status: i.status, timeStart: i.timeStart, updatedTs: i.updatedTs})));
'
```

Expected baseline: ≥1 item, all `status=calendar`, one per future BYDAY date through the horizon. **Record today's item `_id` and `updatedTs`** — you will compare against these post-action.

## When
1. Navigate to `/calendar` (use `Calendar` link in sidebar via `find` + element-ref click — do not click via coordinate).
2. Find today's instance row using `find({query: "Edit button for <routine-title> today calendar item"})`. Click the **Edit** button via element ref.
3. **Verify dialog identity before doing anything else.** Take a screenshot and confirm the dialog shows: title = `<routine-title>`, status = Calendar, date = today, start time = 09:00. If any field is wrong → stop, you opened the wrong item.
4. Click the `Done` status button via `find` + element-ref click.
5. Click `Save changes` via `find` + element-ref click.
6. Wait ≤30s.

**Click protocol — non-negotiable:** every click in this case must be via element ref returned from `find` or `read_page`. **Never use `coordinate` clicks** for the Edit button, Done status, or Save changes. Past runs (#4–6) reported a phantom-duplicate defect that turned out to be a coordinate-click missing its target and creating a second item via a different code path. If `find` returns no match for an action, stop and ask — do not fall back to coordinate clicks.

## Then
Wait ≤30s. Verify all four assertions:

1. **`I.status = done` locally.** Re-run the mongo query above. Today's row must have:
   - **Same `_id`** as the baseline (pure status flip, not a new row).
   - `status: "done"`.
   - `updatedTs` newer than baseline.
2. **No phantom duplicate.** `db.items.countDocuments({title: "<routine-title>", timeStart: "<today>T09:00:00"})` must be **exactly 1**. If it returns 2, see the troubleshooting note below before declaring Fail.
3. **Future items unchanged.** Total item count for the routine is unchanged from baseline. Every future-dated item still has `status=calendar` and `updatedTs == createdTs` (untouched).
4. **`R.routineExceptions` unchanged.** The routine's `routineExceptions` field is still `null` (or unchanged from baseline). Completion ≠ override.
5. **GCal Apr 22 occurrence preserved.** On the GCal tab (navigate to `https://calendar.google.com/calendar/u/2/r/week/<YYYY>/<M>/<D>` for today, no leading zeros), use `find({query: "<routine-title> event on <weekday> <month> <day> 9am"})`. Match must exist on `Yuval GTD Test` calendar.

If all five hold → **Pass**.

## Troubleshooting: two items on today's date
If `count == 2` for today's `timeStart`, do **not** assume a phantom-regen defect. The post-fix code at `client/src/db/itemMutations.ts:247` does not regenerate on disposal — there is no code path that produces a fresh `calendar` item with the same `timeStart` as the just-disposed item. Check instead:

- **Was the original item disposed, or was a second item created and then disposed?** Compare both `_id`s against the baseline. The one matching the baseline `_id` is the original; the other came from somewhere else.
- **Did the first save attempt fail visually but succeed partially?** A coordinate-click that misses Save can still trigger an `updateItem` → second IDB write under a fresh UUID via the status-change path, with the original surviving. The element-ref protocol above eliminates this.
- **Check the operation log** to see who created the second item and when:
  ```bash
  mongosh "mongodb://127.0.0.1:27017/gtd_dev" --quiet --eval '
  db.operations.find({entityId: "<second-item-id>"}).sort({ts: 1}).forEach(o => print(JSON.stringify({ts: o.ts, opType: o.opType, status: o.snapshot?.status})))
  '
  ```

A real defect would need to show a `create` op for a `status=calendar` item with the same `timeStart` as the disposed item, originating after the `done` write, with a code path leading from `clarifyToDone` → generation. None exists in the current code.

## Record
Append result block to `session-1-results.md` per the shared preamble format. Include the today-item `_id` (showing same UUID baseline → done), the unchanged future-item count, and the GCal verification.
