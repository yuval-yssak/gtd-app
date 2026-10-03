import type { StoredItem } from '../types/MyDB';

/**
 * The Google link the server stamps on an item after `events.insert`. Moves as a unit: the three
 * ids and the deep link all describe the same event. Mirrors `CALENDAR_LINK_FIELDS` in
 * `api-server/src/lib/calendarLinkCarryForward.ts` — pinned by the parity case in
 * `tests/calendarLinkMerge.test.ts`; change both together.
 */
export const CALENDAR_LINK_FIELDS = ['calendarEventId', 'calendarIntegrationId', 'calendarSyncConfigId', 'htmlLink'] as const;

/**
 * Sync bookkeeping the server writes without recording an op; each stands on its own. Mirrors
 * `CALENDAR_SYNC_ANCHOR_FIELDS` on the server (same parity pin).
 */
export const CALENDAR_SYNC_ANCHOR_FIELDS = ['calendarInstanceEventId', 'lastPushedToGCalTs', 'lastSyncedNotes', 'lastSyncedFromGCalTs'] as const;

type CarriedField = (typeof CALENDAR_LINK_FIELDS)[number] | (typeof CALENDAR_SYNC_ANCHOR_FIELDS)[number];

/**
 * Statuses where the client strips the Google link on purpose (the status→field matrix forbids
 * it there, and the server removes the event). A local row in one of these must not get the link
 * back from an older pulled snapshot. Mirrors `CALENDAR_DETACH_STATUSES` on the server.
 */
const CALENDAR_DETACH_STATUSES: ReadonlySet<StoredItem['status']> = new Set(['inbox', 'nextAction', 'waitingFor', 'somedayMaybe']);

/**
 * Field-level exception to whole-row last-write-wins for a pulled item snapshot that LOST to a
 * newer local row: the server-owned calendar fields it carries and the local row lacks are merged
 * in (the local row's own fields and `updatedTs` stay as they are). Without this, a device that
 * edits a calendar item before pulling the link the server stamped after the Google create keeps
 * a link-less row — and every later edit it pushes lacks the link too. The server also carries
 * the link forward on apply; this makes it available locally right away (open-in-Google link,
 * read-only Gmail-event warning) instead of after the next echo.
 *
 * Same rules as the server's `carryForwardCalendarLink`:
 *  - same owner only — a cross-account reassign replays the source account's older ops against
 *    the target-owned row, and the target row must not inherit the source's link;
 *  - never into a detach status;
 *  - nothing when the local row names ANOTHER event or integration (a re-targeted row): the pulled
 *    link and its anchors all describe the old event — and a row's missing ids can be a choice
 *    ("Default" calendar), not a gap;
 *  - otherwise the link group when the snapshot carries one, and the anchors field by field.
 *
 * Known limit: a later server op that intentionally REMOVES one of these fields (dead-twin
 * demotion, a sync-engine trash freeing `calendarInstanceEventId`) also loses LWW to the newer
 * local row and cannot undo an earlier merge; the device converges when its own edit echoes back.
 *
 * Returns the merged row, or null when there is nothing to merge. Pure; exported for unit tests.
 */
export function mergeServerOwnedCalendarFields(local: StoredItem, incoming: StoredItem): StoredItem | null {
    if (local.userId !== incoming.userId || CALENDAR_DETACH_STATUSES.has(local.status) || namesAnotherEvent(local, incoming)) {
        return null;
    }
    const anchors = pickAbsentFields(local, incoming, CALENDAR_SYNC_ANCHOR_FIELDS);
    const link = incoming.calendarEventId ? pickAbsentFields(local, incoming, CALENDAR_LINK_FIELDS) : {};
    const merged = { ...anchors, ...link };
    return Object.keys(merged).length > 0 ? { ...local, ...merged } : null;
}

/** Mirrors the server's `namesAnotherEvent`, with the roles swapped: here the LOCAL row is the one that may have moved to another event. */
function namesAnotherEvent(local: StoredItem, incoming: StoredItem): boolean {
    const otherEvent = local.calendarEventId !== undefined && local.calendarEventId !== incoming.calendarEventId;
    const otherIntegration = local.calendarIntegrationId !== undefined && local.calendarIntegrationId !== incoming.calendarIntegrationId;
    return otherEvent || otherIntegration;
}

/** The listed fields the incoming snapshot carries and the local row lacks. */
function pickAbsentFields(local: StoredItem, incoming: StoredItem, fields: readonly CarriedField[]): Partial<StoredItem> {
    const absent = fields.filter((field) => local[field] === undefined && incoming[field] !== undefined);
    return Object.fromEntries(absent.map((field) => [field, incoming[field]]));
}
