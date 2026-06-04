import dayjs from 'dayjs';
import type { CalendarProvider } from '../calendarProviders/CalendarProvider.js';
import { attendeesEqual, buildDeterministicGCalId, isDuplicateIdError } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import type {
    CalendarIntegrationInterface,
    CalendarSyncConfigInterface,
    ItemInterface,
    OperationInterface,
    OpType,
    RoutineInterface,
} from '../types/entities.js';
import { withAuthFailureHandling } from './calendarAuthEscalation.js';
import { integrationStatus } from './calendarIntegrationStatus.js';
import { propagateRoutineNotesToItems } from './calendarItemNotes.js';
import { applyDoneMarker, DONE_COLOR_ID } from './doneMarker.js';
import { markdownToHtml } from './markdownHtml.js';
import { recordOperation } from './operationHelpers.js';
import { regenerateFutureRoutineItems } from './routineItemRegeneration.js';

type ProviderFactory = (integration: CalendarIntegrationInterface, userId: string) => CalendarProvider;

// Tracks entity IDs with a GCal creation in-flight. When a second `create` op arrives for the
// same entity (e.g. from a parallel flush batch), the duplicate is skipped rather than racing
// through the DB re-read guard's TOCTOU window.
// Exported for test cleanup only.
export const gcalCreationInFlight = new Set<string>();

/** Resolved calendar context for push-back: decrypted integration, sync config, provider, and timezone. */
export interface PushContext {
    integration: CalendarIntegrationInterface;
    config: CalendarSyncConfigInterface;
    provider: CalendarProvider;
    timeZone: string;
}

/**
 * Wraps a GCal create call with the deterministic-id idempotency contract: if Google rejects
 * with 409 (the supplied id is already on Google's side from a prior push that crashed before
 * we could write the link locally), treat it as success and return the same id — we can trust
 * the event is ours because we generated the id ourselves.
 */
async function createOr409Relink(integrationId: string, deterministicId: string, doInsert: () => Promise<string>): Promise<string> {
    try {
        return await withAuthFailureHandling(integrationId, doInsert);
    } catch (err) {
        if (isDuplicateIdError(err)) {
            console.log(`[gcal-pushback] GCal event ${deterministicId} already exists (409) — relinking`);
            return deterministicId;
        }
        throw err;
    }
}

/** Identifiers linking an entity to its calendar source — avoids threading 4+ args through helpers. */
interface CalendarLink {
    integrationId: string | undefined;
    configId: string | undefined;
}

/**
 * Identifies the entity whose stale link should be healed when `resolvePushContext` falls back to
 * the user's default integration. Threaded through every callsite that holds an entity in hand —
 * the heal rewrites `calendarIntegrationId`/`calendarSyncConfigId` on the row in place and records
 * an op so other devices converge.
 */
interface HealContext {
    entityType: 'item' | 'routine';
    entityId: string;
}

/**
 * Inspects a server operation and pushes calendar-relevant changes back to Google Calendar.
 * Called fire-and-forget from the sync push handler — errors are logged, not thrown to the caller.
 * Picks up `op.gcalMeta.sendUpdates` (populated by the client's SendUpdatesDialog choice) and
 * threads it through to the provider call; absent → defaults to `'none'`.
 */
export async function maybePushToGCal(op: OperationInterface, buildProvider: ProviderFactory): Promise<void> {
    // OperationInterface.snapshot is a union of all entity types — TypeScript cannot narrow it
    // via entityType since it's not a discriminated union. The casts below are safe because
    // the entityType check guarantees the snapshot shape.
    console.log(`[gcal-pushback] op=${op.opType} entityType=${op.entityType} entityId=${op.entityId} opId=${op._id} ts=${op.ts}`);
    const sendUpdates = op.gcalMeta?.sendUpdates ?? 'none';
    // Item-delete ops travel snapshot:null over the wire. `hydrateDeleteSnapshots` fills the
    // snapshot from the pre-delete row before this fires, so we can read calendarEventId /
    // routineId here. We must NOT route delete ops through `handleItemPush` — that branches on
    // `snapshot.status`, which for a hydrated delete is whatever the item's status was *before*
    // it was hard-deleted (often 'calendar'), so it would push an update for a row that no
    // longer exists.
    if (op.entityType === 'item' && op.opType === 'delete') {
        await handleItemDelete(op.snapshot as ItemInterface | null, op.user, buildProvider);
        return;
    }
    if (op.entityType === 'item' && op.snapshot) {
        await handleItemPush(op.snapshot as ItemInterface, op.user, buildProvider, sendUpdates);
        return;
    }
    if (op.entityType === 'routine' && op.snapshot) {
        await handleRoutinePush(op.snapshot as RoutineInterface, op.user, op.opType, op._id, op.ts, buildProvider);
    }
}

/**
 * GCal-side cleanup when an item is hard-deleted (via `opType: 'delete'`, not a `status: 'trash'`
 * update). Three shapes:
 *  1. Calendar-linked standalone item — `calendarEventId` + integration ids on the snapshot →
 *     delete the GCal event.
 *  2. Routine-generated instance — `routineId` + `timeStart` on the snapshot → cancel that single
 *     occurrence on the routine's master recurring event.
 *  3. No GCal linkage (e.g. inbox item) — no-op.
 *
 * Snapshot:null reaches here only when the row was already gone at hydration time (concurrent
 * delete from another device). No way to recover GCal state in that case — just no-op.
 */
async function handleItemDelete(snapshot: ItemInterface | null, userId: string, buildProvider: ProviderFactory): Promise<void> {
    if (!snapshot) {
        return;
    }
    if (snapshot.calendarEventId) {
        // fromGmail events are read-only via Calendar API — same rationale as pushExistingItemToGCal.
        if (snapshot.eventType === 'fromGmail') {
            console.log(
                `[gcal-pushback] skipping fromGmail event delete (read-only via Calendar API) | eventId=${snapshot.calendarEventId} itemId=${snapshot._id}`,
            );
            return;
        }
        const link: CalendarLink = { integrationId: snapshot.calendarIntegrationId, configId: snapshot.calendarSyncConfigId };
        // Hard-delete: the item row is already gone by the time pushback runs, so heal can't write
        // it back. Skip the heal context — the fallback inside resolvePushContext still kicks in.
        const ctx = await resolvePushContext(link, userId, buildProvider);
        if (!ctx) {
            return;
        }
        console.log(
            `[gcal-pushback] deleting GCal event for hard-deleted item | eventId=${snapshot.calendarEventId} itemId=${snapshot._id} title=${snapshot.title}`,
        );
        await withAuthFailureHandling(ctx.integration._id, () => ctx.provider.deleteEvent(ctx.config.calendarId, snapshot.calendarEventId as string));
        return;
    }
    if (snapshot.routineId && snapshot.timeStart) {
        await pushRoutineInstanceCancellation(snapshot, userId, buildProvider, { skipStamp: true });
    }
}

// ── Item push-back ───────────────────────────────────────────────────────────

async function handleItemPush(snapshot: ItemInterface, userId: string, buildProvider: ProviderFactory, sendUpdates: 'all' | 'none'): Promise<void> {
    // This entity was unlinked by disconnect-with-keep and will be relinked by the next inbound
    // pull (strong-key restore via lastKnownCalendarEventId). Don't create a duplicate by pushing now.
    if (snapshot.lastKnownCalendarEventId) {
        console.debug(
            `[debug-gcal-sync][pushback] skipping item — awaiting reconnect relink | itemId=${snapshot._id} lastKnownEventId=${snapshot.lastKnownCalendarEventId}`,
        );
        return;
    }
    if (snapshot.calendarEventId) {
        await pushExistingItemToGCal(snapshot, userId, buildProvider, sendUpdates);
        return;
    }
    // Routine-generated instance trashed locally → cancel that single GCal occurrence.
    // The item op carries `routineId` + `timeStart`; the master event lives on the routine.
    // Mirrors the `skipped` routineException the client just wrote (matrix A4).
    // `done` is intentionally GTD-local — the GCal occurrence must remain (matrix A8); otherwise
    // the GCal echo round-trips a `deleted` exception back and the app-side item flips to `trash`.
    if (snapshot.routineId && snapshot.status === 'trash') {
        await pushRoutineInstanceCancellation(snapshot, userId, buildProvider);
        return;
    }
    // Routine-generated calendar items carry routineId but no calendarEventId — their GCal
    // presence is the routine's master recurring event. Per-instance edits push a single-instance
    // override on that master (matrix A2/A3); marking done applies the ✓-prefix + sage colorId
    // to that instance (matrix A8); reopen clears both back to the master's defaults.
    if (snapshot.routineId && (snapshot.status === 'calendar' || snapshot.status === 'done')) {
        await pushRoutineInstanceOverride(snapshot, userId, buildProvider, sendUpdates);
        return;
    }
    if (snapshot.status === 'calendar') {
        await pushNewItemToGCal(snapshot, userId, buildProvider, sendUpdates);
    }
}

/**
 * Pushes a per-instance override (time / title / description) to the routine's GCal master
 * recurring event. Used when the user edits a routine-generated calendar item locally, and
 * when marking it done — the latter applies the ✓ title marker + sage colorId on the instance,
 * leaving the master and other occurrences untouched (matrix A8). Reopen (status → 'calendar')
 * clears both: clean title + colorId: null reverts the instance to the master's defaults.
 * No-ops gracefully when the routine isn't linked to GCal yet.
 */
async function pushRoutineInstanceOverride(
    snapshot: ItemInterface,
    userId: string,
    buildProvider: ProviderFactory,
    sendUpdates: 'all' | 'none',
): Promise<void> {
    if (!snapshot.routineId || !snapshot.timeStart || !snapshot._id) {
        return;
    }
    // Defensive parity with pushExistingItemToGCal: a routine-instance shouldn't carry fromGmail
    // in practice (Google never produces recurring events from Gmail), but the type-system reachability
    // is non-zero (routineExceptions can mirror eventType via GCAL_OWNED_ROUTINE_KEYS), and a 400 from
    // GCal would be silent and confusing. Cheaper to skip uniformly than to discover it in prod.
    if (snapshot.eventType === 'fromGmail') {
        console.log(`[gcal-pushback] skipping routine-instance override for fromGmail item | itemId=${snapshot._id}`);
        return;
    }
    const routine = await routinesDAO.findByOwnerAndId(snapshot.routineId, userId);
    if (!routine?.calendarEventId) {
        return;
    }
    const link: CalendarLink = { integrationId: routine.calendarIntegrationId, configId: routine.calendarSyncConfigId };
    // Heal targets the routine — the routine owns the integration link for all generated items.
    const ctx = await resolvePushContext(link, userId, buildProvider, { entityType: 'routine', entityId: routine._id });
    if (!ctx) {
        return;
    }
    const originalDate = resolveOriginalDate(routine, snapshot);
    const { provider, config, timeZone, integration } = ctx;
    const isDone = snapshot.status === 'done';
    const calendarEventId = routine.calendarEventId;
    // Server-side gate: only forward `attendees` when the snapshot's list actually diverges from
    // the routine master's list. `buildCalendarItem` mirrors master attendees onto every generated
    // item, so a title-only edit on a routine instance would otherwise carry attendees identical
    // to the master — forwarding them would silently fork the occurrence per RFC 5545 (the
    // detach-warning client dialog only fires on actual membership changes; the server must be
    // the gate of last resort for non-attendee edits and replayed legacy ops).
    // `attendeesEqual` canonicalizes shape + sort order so key-order drift between the master
    // mirror and the item snapshot doesn't trigger a false-positive divergence.
    const attendeesDiverge = !attendeesEqual(routine.attendees, snapshot.attendees);
    console.log(
        `[gcal-pushback] overriding routine instance | routineId=${snapshot.routineId} eventId=${calendarEventId} originalDate=${originalDate} status=${snapshot.status} attendeesDiverge=${attendeesDiverge}`,
    );
    await withAuthFailureHandling(integration._id, () =>
        provider.updateRecurringInstance(
            calendarEventId,
            originalDate,
            {
                title: isDone ? applyDoneMarker(snapshot.title) : snapshot.title,
                ...(snapshot.timeStart ? { timeStart: snapshot.timeStart } : {}),
                ...(snapshot.timeEnd ? { timeEnd: snapshot.timeEnd } : {}),
                description: snapshot.notes != null ? markdownToHtml(snapshot.notes) : '',
                colorId: isDone ? DONE_COLOR_ID : null,
                // allDay drives {date} vs {dateTime} serialization. attendees forwarding is the
                // explicit "detach this occurrence" gesture (RFC 5545: per-instance attendee list
                // severs inheritance from the master). Gated by the JSON-equality diff above so a
                // title/time/notes edit on a routine instance does NOT silently fork attendees.
                ...(snapshot.allDay !== undefined ? { allDay: snapshot.allDay } : {}),
                ...(attendeesDiverge ? { attendees: snapshot.attendees } : {}),
            },
            config.calendarId,
            timeZone,
            // Patch the known GCal instance directly when the item carries its `calendarInstanceEventId`
            // (set by buildCalendarItem on linked routines). This skips the date-window `events.instances`
            // lookup, which silently misses already-modified instances — the cause of routine-item `done`
            // markers never reaching GCal. Absent (legacy items) → provider falls back to the date lookup.
            { sendUpdates, ...(snapshot.calendarInstanceEventId ? { instanceEventId: snapshot.calendarInstanceEventId } : {}) },
        ),
    );
    await stampItemLastPushed(userId, snapshot._id);
}

/**
 * Cancels the single GCal occurrence that corresponds to a routine-generated item trashed or
 * completed locally. Mirrors `pushRoutineInstanceOverride` structurally — resolves routine,
 * context, and original rrule date, then calls `provider.cancelRecurringInstance`.
 *
 * Skips when the routine is paused: the same batch carries a routine-pause op that caps the
 * master with UNTIL, making per-instance cancellation patches redundant. Skipping also avoids
 * a race we observed in production where N parallel cancellations against the just-capped
 * master caused GCal to drop UNTIL from the master's recurrence.
 *
 * No-ops gracefully when the routine isn't linked to GCal yet or the item lacks a timeStart.
 */
async function pushRoutineInstanceCancellation(
    snapshot: ItemInterface,
    userId: string,
    buildProvider: ProviderFactory,
    opts: { skipStamp?: boolean } = {},
): Promise<void> {
    if (!snapshot.routineId || !snapshot.timeStart || !snapshot._id) {
        return;
    }
    // See pushRoutineInstanceOverride for the fromGmail rationale.
    if (snapshot.eventType === 'fromGmail') {
        console.log(`[gcal-pushback] skipping routine-instance cancellation for fromGmail item | itemId=${snapshot._id}`);
        return;
    }
    const routine = await routinesDAO.findByOwnerAndId(snapshot.routineId, userId);
    if (!routine?.calendarEventId) {
        return;
    }
    if (!routine.active) {
        return;
    }
    const link: CalendarLink = { integrationId: routine.calendarIntegrationId, configId: routine.calendarSyncConfigId };
    // Heal targets the routine — see pushRoutineInstanceOverride.
    const ctx = await resolvePushContext(link, userId, buildProvider, { entityType: 'routine', entityId: routine._id });
    if (!ctx) {
        return;
    }
    const originalDate = resolveOriginalDate(routine, snapshot);
    const { provider, config, integration } = ctx;
    const calendarEventId = routine.calendarEventId;
    console.log(
        `[gcal-pushback] cancelling routine instance | routineId=${snapshot.routineId} eventId=${calendarEventId} originalDate=${originalDate} status=${snapshot.status}`,
    );
    await withAuthFailureHandling(integration._id, () =>
        // Patch the known GCal instance directly when available — see pushRoutineInstanceOverride.
        provider.cancelRecurringInstance(
            calendarEventId,
            originalDate,
            config.calendarId,
            snapshot.calendarInstanceEventId ? { instanceEventId: snapshot.calendarInstanceEventId } : undefined,
        ),
    );
    // Skip stamping when the caller is `handleItemDelete` — the item row has already been
    // hard-deleted by `applyEntityOp`, so the `updateOne` would silently no-op. Wasteful, not
    // wrong, but cleaner to gate it explicitly.
    if (!opts.skipStamp) {
        await stampItemLastPushed(userId, snapshot._id);
    }
}

/**
 * Returns the rrule occurrence date this item was originally generated for.
 * For an un-moved item, `timeStart` still matches the rrule date — use that.
 * For an already-moved item, `timeStart` is the *new* date, so the rrule date only lives
 * on the routine's `modified` exception. Look it up by `itemId` and fall back to `timeStart`
 * if no exception exists yet (first-ever override).
 */
function resolveOriginalDate(routine: RoutineInterface, snapshot: ItemInterface): string {
    const existing = routine.routineExceptions?.find((e) => e.type === 'modified' && e.itemId === snapshot._id);
    if (existing) {
        return existing.date;
    }
    return dayjs(snapshot.timeStart).format('YYYY-MM-DD');
}

/** Pushes edits or deletion of an existing calendar-linked item back to Google Calendar. */
async function pushExistingItemToGCal(snapshot: ItemInterface, userId: string, buildProvider: ProviderFactory, sendUpdates: 'all' | 'none'): Promise<void> {
    const eventId = snapshot.calendarEventId;
    const itemId = snapshot._id;
    if (!eventId || !itemId) {
        return;
    }

    // `fromGmail` events are auto-created by Google from email attachments and are read-only via
    // the Calendar API — Google's contract is "modify via Gmail." Attempts to PATCH/DELETE return
    // 400 Bad Request. Skip pushback entirely; the in-app status change still persists locally.
    // The client surfaces this to the user via a snackbar at the moment of the gesture.
    if (snapshot.eventType === 'fromGmail') {
        console.log(`[gcal-pushback] skipping fromGmail event (read-only via Calendar API) | eventId=${eventId} itemId=${itemId} status=${snapshot.status}`);
        return;
    }

    const link: CalendarLink = { integrationId: snapshot.calendarIntegrationId, configId: snapshot.calendarSyncConfigId };
    const ctx = await resolvePushContext(link, userId, buildProvider, { entityType: 'item', entityId: itemId });
    if (!ctx) {
        return;
    }

    const { provider, config, timeZone, integration } = ctx;

    if (snapshot.status === 'trash') {
        console.log(`[gcal-pushback] deleting GCal event | eventId=${eventId} itemId=${itemId} title=${snapshot.title}`);
        await withAuthFailureHandling(integration._id, () => provider.deleteEvent(config.calendarId, eventId));
        await stampItemLastPushed(userId, itemId);
        return;
    }

    // Done items keep their GCal event but signal completion via a leading "✓ " title marker and
    // a sage colorId. The stored title stays clean — the marker lives only in GCal. Reopen
    // (status → 'calendar') is handled by the generic-update branch below, which sends a clean
    // title and colorId: null to revert both.
    if (snapshot.status === 'done') {
        console.log(`[gcal-pushback] marking GCal event done | eventId=${eventId} itemId=${itemId} title=${snapshot.title}`);
        await withAuthFailureHandling(integration._id, () =>
            provider.updateEvent(
                config.calendarId,
                eventId,
                {
                    title: applyDoneMarker(snapshot.title),
                    ...(snapshot.timeStart ? { timeStart: snapshot.timeStart } : {}),
                    ...(snapshot.timeEnd ? { timeEnd: snapshot.timeEnd } : {}),
                    description: snapshot.notes != null ? markdownToHtml(snapshot.notes) : '',
                    colorId: DONE_COLOR_ID,
                    // allDay/attendees forwarded so the done-marker patch preserves them and
                    // GCal interprets timeStart/timeEnd correctly when the item is all-day.
                    ...(snapshot.allDay !== undefined ? { allDay: snapshot.allDay } : {}),
                    ...(snapshot.attendees !== undefined ? { attendees: snapshot.attendees } : {}),
                },
                timeZone,
                { sendUpdates },
            ),
        );
        const htmlForSync = snapshot.notes != null ? markdownToHtml(snapshot.notes) : undefined;
        await stampItemLastPushed(userId, itemId, htmlForSync);
        return;
    }

    console.log(`[gcal-pushback] updating existing item | eventId=${eventId} title=${snapshot.title} status=${snapshot.status}`);
    // colorId: null clears any prior done-marker color (sage) so a reopened item reverts to the
    // calendar's default color. Idempotent for items that never carried a colorId.
    await withAuthFailureHandling(integration._id, () =>
        provider.updateEvent(
            config.calendarId,
            eventId,
            {
                title: snapshot.title,
                ...(snapshot.timeStart ? { timeStart: snapshot.timeStart } : {}),
                ...(snapshot.timeEnd ? { timeEnd: snapshot.timeEnd } : {}),
                description: snapshot.notes != null ? markdownToHtml(snapshot.notes) : '',
                colorId: null,
                // allDay drives {date} vs {dateTime} serialization in the provider; attendees is the
                // pushable local-write into the otherwise GCal-owned set.
                ...(snapshot.allDay !== undefined ? { allDay: snapshot.allDay } : {}),
                ...(snapshot.attendees !== undefined ? { attendees: snapshot.attendees } : {}),
            },
            timeZone,
            { sendUpdates },
        ),
    );
    const htmlForSync = snapshot.notes != null ? markdownToHtml(snapshot.notes) : undefined;
    await stampItemLastPushed(userId, itemId, htmlForSync);
}

/**
 * Outcome of a context-explicit push helper — informs the caller whether GCal-side state changed
 * and surfaces the recorded operation so the caller can include it in any downstream notify
 * fan-out (web push, etc.) without round-tripping the DB.
 */
export type PushOutcome = { status: 'created' | 'already-linked' | 'skipped'; eventId?: string; recordedOp?: OperationInterface };

/** Creates a new Google Calendar event for an app-created calendar item. */
async function pushNewItemToGCal(snapshot: ItemInterface, userId: string, buildProvider: ProviderFactory, sendUpdates: 'all' | 'none'): Promise<void> {
    if (!snapshot._id) {
        return;
    }
    // Routine-managed items are represented by the routine's GCal recurring series.
    if (snapshot.routineId) {
        return;
    }
    const ctx = await resolveDefaultPushContext(userId, buildProvider);
    if (!ctx) {
        return;
    }
    await pushItemToGCalWithContext(snapshot, ctx, userId, { sendUpdates });
}

/**
 * Creates a GCal event for the given item using a caller-supplied push context. Used by the
 * `Sync now` backfill path which already has the integration/config/provider in scope and wants
 * to operate on items that don't yet carry a `calendarIntegrationId`. Idempotent: a deterministic
 * id is sent to GCal, and a 409 response is treated as already-linked (we re-use the same id).
 * `options.sendUpdates`: defaults to `'none'`; the backfill path leaves this as default since it
 * mints fresh events, while the live edit path threads the SendUpdatesDialog choice through.
 */
export async function pushItemToGCalWithContext(
    snapshot: ItemInterface,
    ctx: PushContext,
    userId: string,
    options?: { sendUpdates?: 'all' | 'none' },
): Promise<PushOutcome> {
    if (!snapshot.timeStart || !snapshot.timeEnd || !snapshot._id) {
        return { status: 'skipped' };
    }
    // Routine-managed items are represented by the routine's GCal recurring series.
    if (snapshot.routineId) {
        return { status: 'skipped' };
    }
    // Disconnect-with-keep marker — let the next inbound pull strong-key restore the link instead
    // of minting a new GCal event whose id will collide with the original on reconnect.
    if (snapshot.lastKnownCalendarEventId) {
        return { status: 'skipped' };
    }
    // Locally bind narrowed values so they survive into the closure passed to withAuthFailureHandling.
    const { timeStart, timeEnd } = snapshot;

    // Guard against concurrent GCal creation for the same item (e.g. duplicate create ops
    // from back-to-back flush batches). Claim the slot synchronously (before any await) so a
    // second call in the same microtask sees the entry and bails out.
    if (gcalCreationInFlight.has(snapshot._id)) {
        console.log(`[gcal-pushback] item ${snapshot._id} GCal creation already in-flight — skipping`);
        return { status: 'skipped' };
    }
    gcalCreationInFlight.add(snapshot._id);
    try {
        // Re-read from DB: a previous (now-completed) push-back may have already linked this entity.
        const current = await itemsDAO.findByOwnerAndId(snapshot._id, userId);
        if (current?.calendarEventId) {
            console.log(`[gcal-pushback] item ${snapshot._id} already linked to GCal event ${current.calendarEventId} — skipping create`);
            return { status: 'already-linked', eventId: current.calendarEventId };
        }

        const { provider, config, integration, timeZone } = ctx;
        // Deterministic id: same (item, integration) pair always maps to the same GCal id, so a
        // retry after a partial failure (GCal succeeded, DB write failed) collides on 409 instead
        // of creating a second event.
        const deterministicId = buildDeterministicGCalId(snapshot._id, integration._id);
        console.log(`[gcal-pushback] creating new GCal event | itemId=${snapshot._id} title=${snapshot.title} gcalId=${deterministicId}`);
        const sendUpdates = options?.sendUpdates ?? 'none';
        const calendarEventId = await createOr409Relink(integration._id, deterministicId, () =>
            provider.createEvent(
                config.calendarId,
                {
                    title: snapshot.title,
                    timeStart,
                    timeEnd,
                    ...(snapshot.notes !== undefined ? { description: markdownToHtml(snapshot.notes) } : {}),
                    // allDay drives the provider's {date} vs {dateTime} serialization. Attendees is
                    // the second local-write into the GCal-owned set (alongside RSVP) — sent verbatim.
                    ...(snapshot.allDay !== undefined ? { allDay: snapshot.allDay } : {}),
                    ...(snapshot.attendees !== undefined ? { attendees: snapshot.attendees } : {}),
                },
                timeZone,
                { id: deterministicId, sendUpdates },
            ),
        );

        const now = dayjs().toISOString();
        await itemsDAO.updateOne(
            { _id: snapshot._id, user: userId },
            {
                $set: {
                    calendarEventId,
                    calendarIntegrationId: integration._id,
                    calendarSyncConfigId: config._id,
                    lastPushedToGCalTs: now,
                    updatedTs: now,
                    ...(snapshot.notes !== undefined ? { lastSyncedNotes: markdownToHtml(snapshot.notes) } : {}),
                },
            },
        );
        // Record an operation so other devices learn about the newly-linked calendar event ID.
        const updated = await itemsDAO.findByOwnerAndId(snapshot._id, userId);
        const recordedOp = updated
            ? await recordOperation(userId, { entityType: 'item', entityId: snapshot._id, snapshot: updated, opType: 'update', now })
            : undefined;
        return { status: 'created', eventId: calendarEventId, ...(recordedOp ? { recordedOp } : {}) };
    } catch (err) {
        console.error(`[calendar-pushback] failed to create GCal event for item ${snapshot._id}:`, err);
        return { status: 'skipped' };
    } finally {
        gcalCreationInFlight.delete(snapshot._id);
    }
}

// ── Routine push-back ────────────────────────────────────────────────────────

async function handleRoutinePush(
    snapshot: RoutineInterface,
    userId: string,
    opType: OpType,
    currentOpId: string,
    currentOpTs: string,
    buildProvider: ProviderFactory,
): Promise<void> {
    if (opType === 'delete') {
        await pushRoutineDeletion(snapshot, userId, buildProvider);
        return;
    }
    // This routine was unlinked by disconnect-with-keep and will be relinked by the next inbound pull
    // (strong-key restore via lastKnownCalendarEventId). Don't create a duplicate by pushing now.
    if (snapshot.lastKnownCalendarEventId) {
        console.debug(
            `[debug-gcal-sync][pushback] skipping routine — awaiting reconnect relink | routineId=${snapshot._id} lastKnownEventId=${snapshot.lastKnownCalendarEventId}`,
        );
        return;
    }
    // Pushback fires after the op has been inserted and the entity has been upserted. Look up the
    // single newest op strictly before this one in (ts, _id) lex order to compare prior vs current
    // active flag. Strictly-before is critical: back-to-back pause ops (e.g. flush batches with
    // identical snapshots) must not see each other as "prior" — the second one would then think
    // there's no active transition and skip the cap, leaving the first pause un-capped in GCal if
    // it also raced on the same lookup.
    const priorActive = await readPriorActiveFlag(snapshot._id, userId, currentOpId, currentOpTs);
    const activeTransitioned = priorActive !== null && priorActive !== snapshot.active;
    if (activeTransitioned && !snapshot.active) {
        await pushRoutinePause(snapshot, userId, buildProvider);
        return;
    }
    if (activeTransitioned && snapshot.active) {
        await pushRoutineResume(snapshot, userId, buildProvider);
        return;
    }
    // Steady-state update (or first-ever push): no active transition — skip GCal mutation entirely
    // if the routine is paused to avoid resurrecting a capped series.
    if (!snapshot.active) {
        return;
    }
    if (snapshot.calendarEventId) {
        await pushExistingRoutineToGCal(snapshot, userId, buildProvider);
        return;
    }
    await pushNewRoutineToGCal(snapshot, userId, buildProvider);
}

/**
 * Reads the routine's `active` value as of the operation immediately preceding the current push.
 * "Preceding" means strictly earlier in (ts, _id) lex order — ops with `ts < currentOpTs`, or the
 * same `ts` but an `_id` that sorts before the current op's `_id`. This ordering:
 *  - makes same-updatedTs collisions from two devices deterministic (the op with the smaller `_id`
 *    is treated as "prior"), and
 *  - makes back-to-back pause ops from one device safe: the second pause op sees the first as prior
 *    (`active=false`) and correctly skips the cap, while the first sees the pre-pause `active=true`
 *    op and fires the cap exactly once.
 * Returns null if this is the routine's first op (no prior op exists).
 */
async function readPriorActiveFlag(routineId: string, userId: string, currentOpId: string, currentOpTs: string): Promise<boolean | null> {
    const [latest] = await operationsDAO.findArray(
        {
            user: userId,
            entityType: 'routine',
            entityId: routineId,
            $or: [{ ts: { $lt: currentOpTs } }, { ts: currentOpTs, _id: { $lt: currentOpId } }],
        },
        { sort: { ts: -1, _id: -1 }, limit: 1 },
    );
    if (!latest) {
        return null;
    }
    const snapshot = latest.snapshot as RoutineInterface | null;
    return snapshot ? snapshot.active : null;
}

/**
 * Pause pushback: trash future generated items and cap the GCal master with UNTIL=<yesterday>.
 * Keeps calendarEventId stable so a future resume can patch the same series. Past GCal occurrences
 * remain intact. No-ops gracefully if the routine isn't linked to GCal.
 */
async function pushRoutinePause(snapshot: RoutineInterface, userId: string, buildProvider: ProviderFactory): Promise<void> {
    const now = dayjs().toISOString();
    // Pause only hits the trash branch (`routine.active === false` short-circuits inside
    // regenerateFutureRoutineItems), so the TZ is never read and a missing value is safe here.
    // Pass `undefined` explicitly so the call site reads intentionally rather than "we forgot".
    await regenerateFutureRoutineItems(snapshot, userId, now, undefined);
    if (!snapshot.calendarEventId) {
        return;
    }
    const link: CalendarLink = { integrationId: snapshot.calendarIntegrationId, configId: snapshot.calendarSyncConfigId };
    const ctx = await resolvePushContext(link, userId, buildProvider, { entityType: 'routine', entityId: snapshot._id });
    if (!ctx) {
        return;
    }
    // UNTIL=<today - 1 day>T235959Z: RFC 5545 format (YYYYMMDDTHHMMSSZ, no separators) in UTC.
    const untilDate = `${dayjs().subtract(1, 'day').utc().format('YYYYMMDD')}T235959Z`;
    const calendarEventId = snapshot.calendarEventId;
    console.log(`[gcal-pushback] capping GCal master for routine pause | routineId=${snapshot._id} until=${untilDate}`);
    try {
        await withAuthFailureHandling(ctx.integration._id, () =>
            ctx.provider.capRecurringEvent(calendarEventId, untilDate, ctx.config.calendarId, ctx.timeZone),
        );
    } catch (err) {
        console.error(`[calendar-pushback] failed to cap recurring event ${calendarEventId} for routine ${snapshot._id}:`, err);
    }
}

/**
 * Resume pushback: clears the pause's UNTIL by pushing the full current rrule back to GCal via
 * events.update, then regenerates future items from the (possibly new) startDate/rrule in the
 * snapshot. No-ops gracefully if the routine isn't linked to GCal yet.
 */
async function pushRoutineResume(snapshot: RoutineInterface, userId: string, buildProvider: ProviderFactory): Promise<void> {
    const now = dayjs().toISOString();
    if (snapshot.calendarEventId) {
        try {
            await pushExistingRoutineToGCal(snapshot, userId, buildProvider);
        } catch (err) {
            // Mirror the pause path: don't block local item regen on GCal transient failures. The
            // next resume-on-save will push the full current rrule and overwrite any stale UNTIL.
            console.error(`[calendar-pushback] resume: failed to push updated series for routine ${snapshot._id}:`, err);
        }
    }
    // Re-read after the GCal push: if resolvePushContext healed a stale calendarIntegrationId on
    // the routine row, the in-memory `snapshot` still carries the dead ids. Without this re-read,
    // `regenerateFutureRoutineItems` would stamp the dead ids onto every freshly-inserted item
    // (which copies from `routine.calendarIntegrationId`/`calendarSyncConfigId` per
    // routineItemRegeneration.ts), defeating the point of the heal.
    const refreshed = (await routinesDAO.findByOwnerAndId(snapshot._id, userId)) ?? snapshot;
    // Need the calendar TZ to compute `calendarInstanceEventId` on generated items. Resolution can
    // fail (integration revoked, no config link); when it does we still regenerate, just without the
    // instance id — the backfill script covers those rows later.
    const tz = await resolveTimeZoneForRoutine(refreshed, userId, buildProvider);
    await regenerateFutureRoutineItems(refreshed, userId, now, tz);
}

/** Returns the calendar TZ for a routine's pushback context, or undefined if unresolvable. */
async function resolveTimeZoneForRoutine(snapshot: RoutineInterface, userId: string, buildProvider: ProviderFactory): Promise<string | undefined> {
    if (!snapshot.calendarEventId) {
        return undefined;
    }
    const link: CalendarLink = { integrationId: snapshot.calendarIntegrationId, configId: snapshot.calendarSyncConfigId };
    // Heal the routine here too — the resume path probes for timezone, and if the link is stale
    // the heal also fixes pause+resume's downstream pushes via the same routine row.
    const ctx = await resolvePushContext(link, userId, buildProvider, { entityType: 'routine', entityId: snapshot._id });
    return ctx?.timeZone;
}

/**
 * Cascades a routine delete: removes the GCal master recurring event (if any) and trashes
 * every generated `calendar`-status item so the app-side calendar doesn't keep rendering
 * occurrences of a routine that no longer exists. Each trashed item records its own
 * server-origin update op so other devices converge via the sync pull.
 * GCal deletion is best-effort — a provider failure does not block the item cascade.
 *
 * `skipGCalDelete: true` keeps the GCal master event intact — used by the integration-disconnect
 * path, which trashes the routine app-side but leaves the user's Google Calendar untouched.
 */
export async function pushRoutineDeletion(
    snapshot: RoutineInterface,
    userId: string,
    buildProvider: ProviderFactory,
    options: { skipGCalDelete?: boolean } = {},
): Promise<void> {
    await trashGeneratedCalendarItems(snapshot._id, userId);
    if (options.skipGCalDelete) {
        return;
    }
    if (!snapshot.calendarEventId) {
        return;
    }
    const link: CalendarLink = { integrationId: snapshot.calendarIntegrationId, configId: snapshot.calendarSyncConfigId };
    // Routine-delete: row is about to disappear, but the heal write inside resolvePushContext is
    // a no-op against a deleted row — safe to pass the heal context regardless. The fallback
    // resolution is what matters here so the GCal delete actually fires.
    const ctx = await resolvePushContext(link, userId, buildProvider, { entityType: 'routine', entityId: snapshot._id });
    if (!ctx) {
        return;
    }
    const calendarEventId = snapshot.calendarEventId;
    console.log(`[gcal-pushback] deleting GCal recurring event for routine | routineId=${snapshot._id} eventId=${calendarEventId}`);
    try {
        await withAuthFailureHandling(ctx.integration._id, () => ctx.provider.deleteRecurringEvent(calendarEventId, ctx.config.calendarId));
    } catch (err) {
        console.error(`[calendar-pushback] failed to delete GCal recurring event ${calendarEventId} for routine ${snapshot._id}:`, err);
    }
}

/**
 * Moves every item generated by the given routine (status 'calendar') to 'trash' and records
 * an op per item so other devices sync the change. The delete-the-routine action explicitly
 * wins over any concurrent in-flight edits to these items — no last-write-wins guard.
 */
async function trashGeneratedCalendarItems(routineId: string, userId: string): Promise<void> {
    const generated = await itemsDAO.findArray({ user: userId, routineId, status: 'calendar' });
    const withId = generated.filter((i): i is ItemInterface & { _id: string } => !!i._id);
    if (!withId.length) {
        return;
    }
    const now = dayjs().toISOString();
    // Free calendarInstanceEventId on trash so a re-import of this series (the GCal master deletion is
    // best-effort and may fail, leaving the series live) can regenerate occurrences without colliding
    // on the presence-partial (user, calendarInstanceEventId) unique index.
    await itemsDAO.updateMany(
        { user: userId, routineId, status: 'calendar' },
        { $set: { status: 'trash', updatedTs: now }, $unset: { calendarInstanceEventId: '' } },
    );
    // Build the post-update snapshot locally rather than re-reading — saves a round trip and the local
    // merge is equivalent since we control the mutation. Drop calendarInstanceEventId so the op snapshot
    // matches the freed DB state (apply replaceById's the full snapshot on other devices).
    await Promise.all(
        withId.map((item) => {
            const { calendarInstanceEventId: _freed, ...rest } = item;
            return recordOperation(userId, {
                entityType: 'item',
                entityId: item._id,
                snapshot: { ...rest, status: 'trash', updatedTs: now },
                opType: 'update',
                now,
            });
        }),
    );
}

/** Pushes edits to an existing GCal recurring event when the routine already has a calendarEventId. */
async function pushExistingRoutineToGCal(snapshot: RoutineInterface, userId: string, buildProvider: ProviderFactory): Promise<void> {
    const { calendarEventId } = snapshot;
    if (!calendarEventId) {
        return;
    }
    const link: CalendarLink = { integrationId: snapshot.calendarIntegrationId, configId: snapshot.calendarSyncConfigId };
    const ctx = await resolvePushContext(link, userId, buildProvider, { entityType: 'routine', entityId: snapshot._id });
    if (!ctx) {
        return;
    }

    await withAuthFailureHandling(ctx.integration._id, () => ctx.provider.updateRecurringEvent(calendarEventId, snapshot, ctx.config.calendarId, ctx.timeZone));
    const htmlForSync = snapshot.template.notes !== undefined ? markdownToHtml(snapshot.template.notes) : undefined;
    await stampRoutineLastPushed(userId, snapshot._id, htmlForSync);
    await propagateRoutineNotesToItems(snapshot._id, snapshot.template.notes, userId);
}

/** Creates a new GCal recurring event for a calendar routine that isn't linked yet. */
async function pushNewRoutineToGCal(snapshot: RoutineInterface, userId: string, buildProvider: ProviderFactory): Promise<void> {
    if (snapshot.routineType !== 'calendar' || !snapshot.calendarIntegrationId) {
        if (snapshot.routineType === 'calendar') {
            console.warn(`[calendar-pushback] routine ${snapshot._id} is calendar type but has no calendarIntegrationId — skipping GCal push`);
        }
        return;
    }
    const link: CalendarLink = { integrationId: snapshot.calendarIntegrationId, configId: snapshot.calendarSyncConfigId };
    const ctx = await resolvePushContext(link, userId, buildProvider, { entityType: 'routine', entityId: snapshot._id });
    if (!ctx) {
        return;
    }
    await pushRoutineToGCalWithContext(snapshot, ctx, userId);
}

/**
 * Creates a GCal recurring event for a calendar-type routine using a caller-supplied push context.
 * Used by the `Sync now` backfill path. Differs from `pushNewRoutineToGCal` in that the routine
 * does not need a pre-stamped `calendarIntegrationId` — the integration comes from the explicit
 * ctx, and `calendarIntegrationId` is written onto the routine as part of the link. Idempotent:
 * deterministic id collides with prior pushes on 409.
 */
export async function pushRoutineToGCalWithContext(snapshot: RoutineInterface, ctx: PushContext, userId: string): Promise<PushOutcome> {
    if (snapshot.routineType !== 'calendar' || !snapshot.calendarItemTemplate) {
        return { status: 'skipped' };
    }
    if (snapshot.active === false) {
        // Mirror handleRoutinePush: inactive routines do not produce GCal mutations.
        return { status: 'skipped' };
    }
    // Disconnect-with-keep marker — wait for the next inbound pull to strong-key restore the link.
    if (snapshot.lastKnownCalendarEventId) {
        return { status: 'skipped' };
    }

    // Guard against concurrent GCal creation for the same routine. See pushItemToGCalWithContext for rationale.
    if (gcalCreationInFlight.has(snapshot._id)) {
        console.log(`[gcal-pushback] routine ${snapshot._id} GCal creation already in-flight — skipping`);
        return { status: 'skipped' };
    }
    gcalCreationInFlight.add(snapshot._id);
    try {
        // Re-read from DB: a previous (now-completed) push-back may have already linked this entity.
        const current = await routinesDAO.findByOwnerAndId(snapshot._id, userId);
        if (current?.calendarEventId) {
            console.log(`[gcal-pushback] routine ${snapshot._id} already linked to GCal event ${current.calendarEventId} — skipping create`);
            return { status: 'already-linked', eventId: current.calendarEventId };
        }

        const deterministicId = buildDeterministicGCalId(snapshot._id, ctx.integration._id);
        const calendarEventId = await createOr409Relink(ctx.integration._id, deterministicId, () =>
            ctx.provider.createRecurringEvent(snapshot, ctx.config.calendarId, ctx.timeZone, { id: deterministicId }),
        );
        const now = dayjs().toISOString();
        await routinesDAO.updateOne(
            { _id: snapshot._id, user: userId },
            {
                $set: {
                    calendarEventId,
                    // Stamp the integration link too — backfill targets routines that don't have it yet.
                    calendarIntegrationId: ctx.integration._id,
                    calendarSyncConfigId: ctx.config._id,
                    lastPushedToGCalTs: now,
                    updatedTs: now,
                    ...(snapshot.template.notes !== undefined ? { lastSyncedNotes: markdownToHtml(snapshot.template.notes) } : {}),
                },
            },
        );
        // Record an operation so other devices sync the newly-linked calendar event ID.
        const updated = await routinesDAO.findByOwnerAndId(snapshot._id, userId);
        const recordedOp = updated
            ? await recordOperation(userId, { entityType: 'routine', entityId: snapshot._id, snapshot: updated, opType: 'update', now })
            : undefined;
        return { status: 'created', eventId: calendarEventId, ...(recordedOp ? { recordedOp } : {}) };
    } catch (err) {
        console.error(`[calendar-pushback] failed to create recurring event for routine ${snapshot._id}:`, err);
        return { status: 'skipped' };
    } finally {
        gcalCreationInFlight.delete(snapshot._id);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolves the push context for an entity that already has integration/config IDs.
 *
 * Self-heal: when the named integration row is gone (typical after disconnect+reconnect, which
 * creates a brand-new integration with a different `_id`) or the named sync config is gone, fall
 * back to the user's default active integration/config. The heal also rewrites the stale link on
 * the entity row in place and records an op for cross-device convergence — so subsequent ops on
 * the same entity don't re-pay this lookup. `(user, provider)` is unique on `calendarIntegrations`,
 * so the fallback target is unambiguous when an active integration exists.
 *
 * `heal` is the entity identity. Required for heal to engage — callsites that don't have an entity
 * in hand (`resolveTimeZoneForRoutine`'s timezone-only probe) pass undefined and behave as before.
 */
async function resolvePushContext(link: CalendarLink, userId: string, buildProvider: ProviderFactory, heal?: HealContext): Promise<PushContext | null> {
    if (!link.integrationId) {
        // Symmetric to the "integration row was deleted" branch: a snapshot can also arrive with
        // `calendarIntegrationId` entirely absent (e.g. a client mutation that drops link fields
        // when staging the snapshot). Caller has a `heal` context AND a calendarEventId, so we
        // can repoint the entity to the user's default active integration just like the stale-id
        // case. The fallback resolves through `tryHealStaleLink → resolveDefaultPushContext` and
        // persists the new ids back onto the entity row.
        console.warn(`[calendar-pushback] resolvePushContext: no integrationId — attempting heal fallback`);
        return await tryHealStaleLink(link, userId, buildProvider, heal, 'integration-absent');
    }
    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(link.integrationId, userId);
    if (!integration) {
        console.warn(`[calendar-pushback] resolvePushContext: integration ${link.integrationId} not found for user ${userId}`);
        return await tryHealStaleLink(link, userId, buildProvider, heal, 'integration-missing');
    }
    // Suspended/revoked integrations: pushback is a no-op. The auth-escalation flow owns their
    // lifecycle and hitting Google again would re-trigger the same invalid_grant.
    if (integrationStatus(integration) !== 'active') {
        console.log(`[calendar-pushback] skipping ${integrationStatus(integration)} integration ${integration._id}`);
        return null;
    }
    const config = link.configId
        ? await calendarSyncConfigsDAO.findByOwnerAndId(link.configId, userId)
        : ((await calendarSyncConfigsDAO.findEnabledByIntegration(link.integrationId)).find((c) => c.isDefault) ?? null);
    if (!config) {
        console.warn(`[calendar-pushback] resolvePushContext: no sync config found (configId=${link.configId ?? 'none'}, integrationId=${link.integrationId})`);
        return await tryHealStaleLink(link, userId, buildProvider, heal, 'config-missing');
    }
    const provider = buildProvider(integration, userId);
    const timeZone = await withAuthFailureHandling(integration._id, () => ensureTimeZone(config, provider));
    return { integration, config, provider, timeZone };
}

/**
 * Heals a stale `calendarIntegrationId` / `calendarSyncConfigId` on the entity row by repointing
 * it to the user's current default active integration. Returns the healed push context, or null
 * when no fallback exists (e.g. user is currently disconnected). Records an op so other devices
 * converge to the healed link without going through their own pushback path first.
 *
 * Skips the persist step when `heal` is undefined — that means the caller is doing a read-only
 * probe (`resolveTimeZoneForRoutine`) and doesn't own a single entity to rewrite. The fallback
 * context is still returned so the probe gets a usable timezone.
 */
async function tryHealStaleLink(
    link: CalendarLink,
    userId: string,
    buildProvider: ProviderFactory,
    heal: HealContext | undefined,
    reason: 'integration-missing' | 'config-missing' | 'integration-absent',
): Promise<PushContext | null> {
    const fallback = await resolveDefaultPushContext(userId, buildProvider);
    if (!fallback) {
        return null;
    }
    if (!heal) {
        return fallback;
    }
    // Skip persist if the fallback ids match the stale ids — happens when the config row exists
    // but the integration row was filtered out by status, etc. We log + return the fallback ctx
    // but don't waste a write or an op when nothing about the link actually changed.
    if (fallback.integration._id === link.integrationId && fallback.config._id === link.configId) {
        return fallback;
    }
    const now = dayjs().toISOString();
    const newIntegrationId = fallback.integration._id;
    const newConfigId = fallback.config._id;
    console.log(
        `[calendar-pushback] healing stale link | reason=${reason} entity=${heal.entityType}:${heal.entityId} oldIntegrationId=${link.integrationId ?? 'none'} newIntegrationId=${newIntegrationId} oldConfigId=${link.configId ?? 'none'} newConfigId=${newConfigId}`,
    );
    const updated = await persistHealedLink(heal, userId, newIntegrationId, newConfigId);
    if (updated) {
        await recordOperation(userId, { entityType: heal.entityType, entityId: heal.entityId, snapshot: updated, opType: 'update', now });
    }
    return fallback;
}

/**
 * Writes the healed link onto the entity row and returns the updated snapshot (or null if the row vanished).
 * Intentionally does NOT bump `updatedTs` — these are plumbing-only id rewrites, not user-meaningful
 * changes. Mirrors the `stampItemLastPushed` precedent: bumping the LWW anchor for a server-internal
 * write would let a heal that races a concurrent offline client edit silently lock that edit out on
 * replay (existing.updatedTs would be artificially newer than the legitimate client snapshot.updatedTs).
 * The recorded op carries the entity's unchanged `updatedTs`, so cross-device LWW stays correct.
 */
async function persistHealedLink(
    heal: HealContext,
    userId: string,
    newIntegrationId: string,
    newConfigId: string,
): Promise<ItemInterface | RoutineInterface | null> {
    const dao = heal.entityType === 'item' ? itemsDAO : routinesDAO;
    await dao.updateOne({ _id: heal.entityId, user: userId }, { $set: { calendarIntegrationId: newIntegrationId, calendarSyncConfigId: newConfigId } });
    return await dao.findByOwnerAndId(heal.entityId, userId);
}

/** Resolves the push context using the user's default sync config (for new app-created items). */
async function resolveDefaultPushContext(userId: string, buildProvider: ProviderFactory): Promise<PushContext | null> {
    const configs = await calendarSyncConfigsDAO.findByUser(userId);
    const defaultConfig = configs.find((c) => c.isDefault && c.enabled);
    if (!defaultConfig) {
        return null;
    }
    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(defaultConfig.integrationId, userId);
    if (!integration) {
        return null;
    }
    // Mirror resolvePushContext — pushback is a no-op for suspended/revoked integrations.
    if (integrationStatus(integration) !== 'active') {
        console.log(`[calendar-pushback] skipping ${integrationStatus(integration)} integration ${integration._id}`);
        return null;
    }
    const provider = buildProvider(integration, userId);
    const timeZone = await ensureTimeZone(defaultConfig, provider);
    return { integration, config: defaultConfig, provider, timeZone };
}

/** Returns the cached timezone from the config, or fetches it from Google and persists it. */
export async function ensureTimeZone(config: CalendarSyncConfigInterface, provider: CalendarProvider): Promise<string> {
    if (config.timeZone) {
        return config.timeZone;
    }
    const timeZone = await provider.getCalendarTimeZone(config.calendarId);
    await calendarSyncConfigsDAO.upsertTimeZone(config._id, timeZone);
    return timeZone;
}

/** Stamps `lastPushedToGCalTs` on an item so the inbound sync can detect its own echo. */
async function stampItemLastPushed(userId: string, itemId: string, lastSyncedNotes?: string): Promise<void> {
    const now = dayjs().toISOString();
    // updatedTs intentionally omitted — stamping the echo-detection marker should not change the
    // conflict-resolution anchor; otherwise a subsequent GCal edit would always appear "older".
    await itemsDAO.updateOne(
        { _id: itemId, user: userId },
        { $set: { lastPushedToGCalTs: now, ...(lastSyncedNotes !== undefined ? { lastSyncedNotes } : {}) } },
    );
}

/** Stamps `lastPushedToGCalTs` on a routine so the inbound sync can detect its own echo. */
async function stampRoutineLastPushed(userId: string, routineId: string, lastSyncedNotes?: string): Promise<void> {
    const now = dayjs().toISOString();
    // updatedTs intentionally omitted — see stampItemLastPushed for rationale.
    await routinesDAO.updateOne(
        { _id: routineId, user: userId },
        { $set: { lastPushedToGCalTs: now, ...(lastSyncedNotes !== undefined ? { lastSyncedNotes } : {}) } },
    );
}
