# Priority order on every list, editor shortcuts, legend everywhere

Status: **Phase A implemented on `exp/keyboard-regions`** (2026-10-23; client and API reviews Approved; uncommitted). Phase B needs the decisions marked **Decide** below.

## The request

- Change priority on the Inbox, Someday / Maybe, Waiting For (by date: within a date; by person: person against person, and
  the "Unassigned" block too), Routines, People and Work Contexts — not only Next Actions.
- Calendar stays purely chronological (no manual order). It already is: all-day events first, then timed events by start.
- Shortcuts inside the item editor.
- The keyboard-shortcuts icon on every screen.

## Phase A — items only, no data-model change

`rank` is already universal on items (minted on capture, carried across statuses, validated, carried forward on the server),
so ordering more ITEM lists is client work:

- **Inbox** and **Someday / Maybe**: one section each, rank order (a fresh capture is minted at the top, so the default stays
  newest-first). The inbox wizard and the Weekly Review stage the inbox in the same order (the page/staging mirror rule).
- **Waiting For, by date**: one section per `expectedBy` day (undated first, as today), rank order inside a day.
- The reorder engine (`reorderItem`, the drag hook, the roving list, Move to…, the editor Position row) is generalized from
  "next action day sections" to "a status + a section key".
- **Editor shortcuts** (`components/itemEditor`): Cmd/Ctrl+Enter saves; with focus outside a text field, bare letters pick
  the status chip (i inbox, n next action, c calendar, w waiting for, s someday, d done, t trash) and Alt+Shift+↑/↓ /
  Alt+↑/↓ move the item (the Position row) — the same keys as the list. Every chip and button names its key in its tooltip.
- **Legend everywhere**: the keyboard icon moves from the Next Actions header to the sidebar brand row on every desktop screen (none on phones, per the user: touch has no shortcuts).
- **Backfill**: `backfillItemRanks.ts` gained a pass that ranks the open lists' pre-rollout (unranked) rows after their
  status's ranked ones, in their old order — without it an old capture would sort above today's (unranked sorts first).
- Implementation: the Next Actions wiring was extracted into `hooks/useRankedList.ts` + `components/rankedList/`, which every
  ranked list now uses; the item editor's Position row shows for any ranked status.

## Phase B — ranks on routines, people and work contexts

These entities have no `rank` yet: adding one touches `entities.ts`, the op snapshot schemas (strict superset!), the `/v1`
projections, `PUBLIC_API.md`, the MCP tool descriptions, the client mirrors, minting on create and a backfill — the same
shape as the item rank, three times.

- **Routines**: rank order inside each frequency group of the Routines page (the groups themselves stay).
  **Decide:** also within the Next Actions / Calendar tabs only, or one order across tabs?
- **People / Work Contexts**: rank order on their pages. **Decide:** do the filter-chip rows and pickers keep their
  most-used-first order (my recommendation — they are tuned for speed), or follow the manual order?
- **Waiting For, by person**: person blocks follow the People rank; items inside a block keep their date order.
  **Decide where the "Unassigned" block's position lives:**
  1. a per-device setting (localStorage) — simplest, but not synced between devices;
  2. (recommended) a new synced per-user preferences entity — synced like everything else; costs a new collection, an IDB
     store, a schema bump and a deletion/export inventory entry, and is reusable for future per-user preferences.
