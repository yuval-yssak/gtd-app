import itemsDAO from '../dataAccess/itemsDAO.js';
import type { ItemInterface, OperationInterface } from '../types/entities.js';
import { CALENDAR_DETACH_STATUSES } from './applyEntityOp.js';

/**
 * The Google link pushback stamps on an item after `events.insert` (`stampItemCalendarLink`).
 * Written server-side only, so a client snapshot that lacks `calendarEventId` is one the client
 * has not pulled the link into yet — never an intentional unlink. Carried as a unit: the three ids
 * and the deep link all describe the same event.
 */
export const CALENDAR_LINK_FIELDS = ['calendarEventId', 'calendarIntegrationId', 'calendarSyncConfigId', 'htmlLink'] as const;

/**
 * Sync bookkeeping the server writes without recording an op (echo detection, inbound anchors,
 * the routine-instance id backfill). Each stands on its own, so each is carried independently.
 */
export const CALENDAR_SYNC_ANCHOR_FIELDS = ['calendarInstanceEventId', 'lastPushedToGCalTs', 'lastSyncedNotes', 'lastSyncedFromGCalTs'] as const;

type CarriedField = (typeof CALENDAR_LINK_FIELDS)[number] | (typeof CALENDAR_SYNC_ANCHOR_FIELDS)[number];

/**
 * Merges the server-owned calendar fields of the stored row into an incoming item snapshot that
 * lacks them. The whole-snapshot `replaceById` apply otherwise erases them whenever a client edits
 * (or completes, or trashes) a calendar item before its pull delivered the link the server stamped
 * after the Google create — the 2026-09-27 production incident: the ✓ done marker never reached
 * Google and the event was orphaned for good. Pure; exported for unit tests. The client mirrors
 * these rules in `client/src/db/calendarLinkMerge.ts` (field lists pinned by a parity case in
 * both test files) — change both together.
 *
 * Carry rules:
 *  - never for a detach status (inbox/nextAction/waitingFor/somedayMaybe) — there the client strips
 *    the link on purpose and `hydrateCalendarDetachSnapshots` removes the Google event;
 *  - nothing when the snapshot names ANOTHER event or integration (a re-targeted item): the stored
 *    link and its anchors all describe the old event;
 *  - otherwise the link group when the stored row has one, and the anchors field by field.
 *
 * Deliberately NOT covered: the disconnect-keep markers (`lastKnownCalendar*`). A snapshot that
 * still carries the live link while the row holds markers is a different conflict (the client
 * missed the disconnect rename), and merging markers next to a live link would leave both set.
 */
export function carryForwardCalendarLink(existing: ItemInterface, incoming: ItemInterface): ItemInterface {
    if (CALENDAR_DETACH_STATUSES.has(incoming.status) || namesAnotherEvent(existing, incoming)) {
        return incoming;
    }
    const anchors = pickAbsentFields(existing, incoming, CALENDAR_SYNC_ANCHOR_FIELDS);
    const link = existing.calendarEventId ? pickAbsentFields(existing, incoming, CALENDAR_LINK_FIELDS) : {};
    return { ...incoming, ...anchors, ...link };
}

function namesAnotherEvent(existing: ItemInterface, incoming: ItemInterface): boolean {
    const otherEvent = incoming.calendarEventId !== undefined && incoming.calendarEventId !== existing.calendarEventId;
    const otherIntegration = incoming.calendarIntegrationId !== undefined && incoming.calendarIntegrationId !== existing.calendarIntegrationId;
    return otherEvent || otherIntegration;
}

/** The listed fields that the stored row carries and the incoming snapshot lacks. */
function pickAbsentFields(existing: ItemInterface, incoming: ItemInterface, fields: readonly CarriedField[]): Partial<ItemInterface> {
    const absent = fields.filter((field) => incoming[field] === undefined && existing[field] !== undefined);
    return Object.fromEntries(absent.map((field) => [field, existing[field]]));
}

/**
 * Apply-pipeline hydrator: rewrites `op.snapshot` in place with the carried-forward fields so the
 * collection row, the op log (what other devices — and the originating one — pull) and the GCal
 * pushback (which reads `op.snapshot`) all see the merged state. MUST run before `applyEntityOp`
 * overwrites the row. Skips create/update ops that are not items, and detach-status snapshots.
 * Not gated on last-write-wins: a stale op is not applied anyway, and a merged stale snapshot is
 * harmless to replay. The read here and the `replaceById` in `applyEntityOp` are not atomic — a link
 * stamp landing in between is still overwritten; that millisecond window is closed from the other
 * side by `pushStateReachedDuringCreate` in calendarPushback.ts, which re-pushes the row's state
 * after the stamp.
 */
export async function hydrateCalendarLinkCarryForward(userId: string, ops: OperationInterface[]): Promise<void> {
    const targets = ops.filter(isCarryForwardCandidate);
    if (!targets.length) {
        return;
    }
    await Promise.all(targets.map((op) => carryForwardOne(userId, op)));
}

function isCarryForwardCandidate(op: OperationInterface): boolean {
    if (op.entityType !== 'item' || (op.opType !== 'create' && op.opType !== 'update') || !op.snapshot) {
        return false;
    }
    return !CALENDAR_DETACH_STATUSES.has((op.snapshot as ItemInterface).status);
}

async function carryForwardOne(userId: string, op: OperationInterface): Promise<void> {
    const existing = await itemsDAO.findByOwnerAndId(op.entityId, userId);
    if (!existing) {
        return;
    }
    op.snapshot = carryForwardCalendarLink(existing, op.snapshot as ItemInterface);
}
