import { z } from 'zod';
import type { ItemInterface } from '../../types/entities.js';
import {
    energySchema,
    floatingDateTime,
    gcalAttendeeSchema,
    gcalEventTypeSchema,
    gcalPersonSchema,
    gcalResponseStatusSchema,
    isoDateOrDateTime,
    isoDateTime,
    itemStatusSchema,
    nonEmptyString,
} from './shared.js';

// Item snapshot schema — every persistable field. The status→field matrix runs as a separate
// pass (`assertStatusFieldRules`) so violation messages can pinpoint the offending status×field
// cell instead of a generic "extra key" error.
export const ItemSnapshotSchema = z
    .object({
        _id: nonEmptyString,
        user: nonEmptyString,
        status: itemStatusSchema,
        // Title is required and non-empty: empty-title items break list rendering, search, and
        // every audit script that assumes title is meaningful. Enforced at the schema layer so
        // /sync/push, /v1 PATCH, and /v1/operations/batch all reject empty titles uniformly.
        title: nonEmptyString,
        createdTs: isoDateTime,
        updatedTs: isoDateTime,
        notes: z.string().optional(),
        workContextIds: z.array(nonEmptyString).optional(),
        peopleIds: z.array(nonEmptyString).optional(),
        waitingForPersonId: nonEmptyString.optional(),
        expectedBy: isoDateOrDateTime.optional(),
        ignoreBefore: isoDateOrDateTime.optional(),
        // Floating wall-clock — paired with calendar timeZone when sent to GCal. See shared.ts.
        // For all-day items, these are YYYY-MM-DD strings (also accepted by floatingDateTime).
        timeStart: floatingDateTime.optional(),
        timeEnd: floatingDateTime.optional(),
        calendarEventId: nonEmptyString.optional(),
        calendarIntegrationId: nonEmptyString.optional(),
        calendarSyncConfigId: nonEmptyString.optional(),
        // Disconnect-with-keep markers — pushed back when a client re-edits an item that was
        // unlinked server-side. Validator must accept them so the round-trip doesn't 400.
        lastKnownCalendarEventId: nonEmptyString.optional(),
        lastKnownCalendarIntegrationId: nonEmptyString.optional(),
        lastKnownCalendarSyncConfigId: nonEmptyString.optional(),
        lastKnownCalendarAccountEmail: nonEmptyString.optional(),
        // GCal instance event id for routine-generated calendar items. Pushed back when the client
        // re-edits the item locally (e.g. drag in week view).
        calendarInstanceEventId: nonEmptyString.optional(),
        lastPushedToGCalTs: isoDateTime.optional(),
        lastSyncedFromGCalTs: isoDateTime.optional(),
        lastSyncedNotes: z.string().optional(),
        routineId: nonEmptyString.optional(),
        energy: energySchema.optional(),
        time: z.number().nonnegative().optional(),
        focus: z.boolean().optional(),
        urgent: z.boolean().optional(),
        externalId: nonEmptyString.optional(),
        contentHash: nonEmptyString.optional(),
        // GCal-mirror fields (Phase 1a). Server-overwritten on inbound pulls; update ops that
        // round-trip through /sync/push include these so the strict schema must accept them.
        allDay: z.boolean().optional(),
        organizer: gcalPersonSchema.optional(),
        creator: gcalPersonSchema.optional(),
        attendees: z.array(gcalAttendeeSchema).optional(),
        responseStatus: gcalResponseStatusSchema.optional(),
        eventType: gcalEventTypeSchema.optional(),
        // Read-only GCal-owned conferencing/location/event-URL. Server-overwritten on inbound; update
        // ops that round-trip through /sync/push include them so the strict schema must accept them.
        meetingLink: z.string().optional(),
        location: z.string().optional(),
        htmlLink: z.string().optional(),
        cancelledByGCal: z.boolean().optional(),
    })
    .strict();

export type ItemSnapshot = z.infer<typeof ItemSnapshotSchema>;

export const ItemCreateSchema = z.object({
    entityType: z.literal('item'),
    opType: z.literal('create'),
    entityId: nonEmptyString,
    snapshot: ItemSnapshotSchema,
});

export const ItemUpdateSchema = z.object({
    entityType: z.literal('item'),
    opType: z.literal('update'),
    entityId: nonEmptyString,
    snapshot: ItemSnapshotSchema,
});

export const ItemDeleteSchema = z.object({
    entityType: z.literal('item'),
    opType: z.literal('delete'),
    entityId: nonEmptyString,
    snapshot: z.null(),
});

/** Payload validator for `opType: 'rsvp'` ops. responseStatus is constrained to the three values
 *  the RSVP UI can emit — `needsAction` is reserved for inbound parsing and is not a valid push. */
export const RsvpOpPayloadSchema = z
    .object({
        itemId: nonEmptyString,
        calendarEventId: nonEmptyString,
        calendarIntegrationId: nonEmptyString,
        responseStatus: z.enum(['accepted', 'declined', 'tentative']),
    })
    .strict();

export const ItemRsvpSchema = z.object({
    entityType: z.literal('item'),
    opType: z.literal('rsvp'),
    entityId: nonEmptyString,
    snapshot: z.null(),
    rsvp: RsvpOpPayloadSchema,
});

// Status → allowed status-specific optional fields. Universal fields (title, notes, _id, user,
// createdTs, updatedTs, externalId, contentHash, lastPushed*, lastSynced*, routineId,
// calendarSyncConfigId) are not subject to status gating and are always allowed.
const STATUS_SPECIFIC_FIELDS = [
    'workContextIds',
    'peopleIds',
    'waitingForPersonId',
    'energy',
    'time',
    'focus',
    'urgent',
    'expectedBy',
    'ignoreBefore',
    'timeStart',
    'timeEnd',
    'allDay',
    'calendarEventId',
    'calendarIntegrationId',
    'calendarInstanceEventId',
] as const;

export type StatusSpecificField = (typeof STATUS_SPECIFIC_FIELDS)[number];

// `done` and `trash` are historical/archival statuses — they preserve whatever status-specific
// fields the item carried at completion/disposal so audit-trail queries (e.g. "items completed
// for date X") keep working. The strict matrix only applies to the active statuses where field
// drift causes real bugs (e.g. ignoreBefore on calendar). CLAUDE.md's "no additional fields"
// note describes the API surface for new items, not the persistence shape after transition.
const ALL_STATUS_SPECIFIC: ReadonlySet<StatusSpecificField> = new Set(STATUS_SPECIFIC_FIELDS);

export const STATUS_FIELD_MATRIX: Record<ItemInterface['status'], ReadonlySet<StatusSpecificField>> = {
    inbox: new Set(),
    nextAction: new Set(['workContextIds', 'peopleIds', 'energy', 'time', 'focus', 'urgent', 'expectedBy', 'ignoreBefore']),
    calendar: new Set(['timeStart', 'timeEnd', 'allDay', 'calendarEventId', 'calendarIntegrationId', 'calendarInstanceEventId', 'workContextIds', 'peopleIds']),
    waitingFor: new Set(['waitingForPersonId', 'peopleIds', 'expectedBy', 'ignoreBefore']),
    somedayMaybe: new Set(['expectedBy', 'ignoreBefore']),
    done: ALL_STATUS_SPECIFIC,
    trash: ALL_STATUS_SPECIFIC,
};

export interface StatusFieldViolation {
    status: ItemInterface['status'];
    field: StatusSpecificField;
    message: string;
}

/**
 * Enforces the status→field matrix on an item snapshot. Runs after Zod parse so the snapshot's
 * status field is already narrowed to the enum. Returns the first violation found (for a clear
 * error message) or `null` when the snapshot is conformant. The audit script aggregates results
 * across many ops to produce a status×field heatmap; for the runtime path the first violation is
 * what we surface in the 400 response.
 */
export function assertStatusFieldRules(snapshot: ItemSnapshot): StatusFieldViolation | null {
    const allowed = STATUS_FIELD_MATRIX[snapshot.status as ItemInterface['status']];
    for (const field of STATUS_SPECIFIC_FIELDS) {
        const isPresent = snapshot[field] !== undefined;
        if (isPresent && !allowed.has(field)) {
            return {
                status: snapshot.status as ItemInterface['status'],
                field,
                message: `field "${field}" is not allowed when status is "${snapshot.status}"`,
            };
        }
    }
    return null;
}

export const STATUS_SPECIFIC_FIELD_LIST: ReadonlyArray<StatusSpecificField> = STATUS_SPECIFIC_FIELDS;

/**
 * Strips status-specific fields the matrix disallows for the snapshot's status. `/sync/push`
 * runs this BEFORE strict validation: deployed clients have shipped transitions that leave a
 * disallowed field on the snapshot (e.g. `expectedBy` surviving nextAction→calendar), and a 400
 * there permanently jams the device's offline queue — every later edit on that device is stuck
 * behind the poisoned op. Sanitizing server-side heals already-queued ops with no user action.
 * `/v1` callers keep the strict 400: they get immediate feedback and have no queue to jam.
 */
export function stripDisallowedStatusFields(snapshot: Record<string, unknown>): { sanitized: Record<string, unknown>; strippedFields: StatusSpecificField[] } {
    // Destructure to read off the index signature (dot access trips TS4111, bracket trips Biome useLiteralKeys).
    const { status } = snapshot;
    const allowed = STATUS_FIELD_MATRIX[status as ItemInterface['status']];
    // Unknown/missing status → nothing to strip; Zod rejects the snapshot downstream.
    if (!allowed) {
        return { sanitized: snapshot, strippedFields: [] };
    }
    const strippedFields = STATUS_SPECIFIC_FIELDS.filter((field) => snapshot[field] !== undefined && !allowed.has(field));
    const strippedKeys = new Set<string>(strippedFields);
    const sanitized = Object.fromEntries(Object.entries(snapshot).filter(([key]) => !strippedKeys.has(key)));
    return { sanitized, strippedFields };
}
