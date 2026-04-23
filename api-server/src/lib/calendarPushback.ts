import dayjs from 'dayjs';
import type { CalendarProvider } from '../calendarProviders/CalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import type {
    CalendarIntegrationInterface,
    CalendarSyncConfigInterface,
    ItemInterface,
    OperationInterface,
    OpType,
    RoutineInterface,
} from '../types/entities.js';
import { propagateRoutineNotesToItems } from './calendarItemNotes.js';
import { markdownToHtml } from './markdownHtml.js';
import { recordOperation } from './operationHelpers.js';

type ProviderFactory = (integration: CalendarIntegrationInterface, userId: string) => CalendarProvider;

// Tracks entity IDs with a GCal creation in-flight. When a second `create` op arrives for the
// same entity (e.g. from a parallel flush batch), the duplicate is skipped rather than racing
// through the DB re-read guard's TOCTOU window.
// Exported for test cleanup only.
export const gcalCreationInFlight = new Set<string>();

/** Resolved calendar context for push-back: decrypted integration, sync config, provider, and timezone. */
interface PushContext {
    integration: CalendarIntegrationInterface;
    config: CalendarSyncConfigInterface;
    provider: CalendarProvider;
    timeZone: string;
}

/** Identifiers linking an entity to its calendar source — avoids threading 4+ args through helpers. */
interface CalendarLink {
    integrationId: string | undefined;
    configId: string | undefined;
}

/**
 * Inspects a server operation and pushes calendar-relevant changes back to Google Calendar.
 * Called fire-and-forget from the sync push handler — errors are logged, not thrown to the caller.
 */
export async function maybePushToGCal(op: OperationInterface, buildProvider: ProviderFactory): Promise<void> {
    // OperationInterface.snapshot is a union of all entity types — TypeScript cannot narrow it
    // via entityType since it's not a discriminated union. The casts below are safe because
    // the entityType check guarantees the snapshot shape.
    console.log(`[gcal-pushback] op=${op.opType} entityType=${op.entityType} entityId=${op.entityId}`);
    if (op.entityType === 'item' && op.snapshot) {
        await handleItemPush(op.snapshot as ItemInterface, op.user, buildProvider);
        return;
    }
    if (op.entityType === 'routine' && op.snapshot) {
        await handleRoutinePush(op.snapshot as RoutineInterface, op.user, op.opType, buildProvider);
    }
}

// ── Item push-back ───────────────────────────────────────────────────────────

async function handleItemPush(snapshot: ItemInterface, userId: string, buildProvider: ProviderFactory): Promise<void> {
    if (snapshot.calendarEventId) {
        await pushExistingItemToGCal(snapshot, userId, buildProvider);
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
    // override on that master (matrix A2/A3).
    if (snapshot.status === 'calendar' && snapshot.routineId) {
        await pushRoutineInstanceOverride(snapshot, userId, buildProvider);
        return;
    }
    if (snapshot.status === 'calendar') {
        await pushNewItemToGCal(snapshot, userId, buildProvider);
    }
}

/**
 * Pushes a per-instance override (time / title / description) to the routine's GCal master
 * recurring event. Used when the user edits a routine-generated calendar item locally.
 * No-ops gracefully when the routine isn't linked to GCal yet.
 */
async function pushRoutineInstanceOverride(snapshot: ItemInterface, userId: string, buildProvider: ProviderFactory): Promise<void> {
    if (!snapshot.routineId || !snapshot.timeStart || !snapshot._id) {
        return;
    }
    const routine = await routinesDAO.findByOwnerAndId(snapshot.routineId, userId);
    if (!routine?.calendarEventId) {
        return;
    }
    const link: CalendarLink = { integrationId: routine.calendarIntegrationId, configId: routine.calendarSyncConfigId };
    const ctx = await resolvePushContext(link, userId, buildProvider);
    if (!ctx) {
        return;
    }
    const originalDate = resolveOriginalDate(routine, snapshot);
    const { provider, config, timeZone } = ctx;
    console.log(
        `[gcal-pushback] overriding routine instance | routineId=${snapshot.routineId} eventId=${routine.calendarEventId} originalDate=${originalDate}`,
    );
    await provider.updateRecurringInstance(
        routine.calendarEventId,
        originalDate,
        {
            title: snapshot.title,
            ...(snapshot.timeStart ? { timeStart: snapshot.timeStart } : {}),
            ...(snapshot.timeEnd ? { timeEnd: snapshot.timeEnd } : {}),
            description: snapshot.notes != null ? markdownToHtml(snapshot.notes) : '',
        },
        config.calendarId,
        timeZone,
    );
    await stampItemLastPushed(userId, snapshot._id);
}

/**
 * Cancels the single GCal occurrence that corresponds to a routine-generated item trashed or
 * completed locally. Mirrors `pushRoutineInstanceOverride` structurally — resolves routine,
 * context, and original rrule date, then calls `provider.cancelRecurringInstance`.
 * No-ops gracefully when the routine isn't linked to GCal yet or the item lacks a timeStart.
 */
async function pushRoutineInstanceCancellation(snapshot: ItemInterface, userId: string, buildProvider: ProviderFactory): Promise<void> {
    if (!snapshot.routineId || !snapshot.timeStart || !snapshot._id) {
        return;
    }
    const routine = await routinesDAO.findByOwnerAndId(snapshot.routineId, userId);
    if (!routine?.calendarEventId) {
        return;
    }
    const link: CalendarLink = { integrationId: routine.calendarIntegrationId, configId: routine.calendarSyncConfigId };
    const ctx = await resolvePushContext(link, userId, buildProvider);
    if (!ctx) {
        return;
    }
    const originalDate = resolveOriginalDate(routine, snapshot);
    const { provider, config } = ctx;
    console.log(
        `[gcal-pushback] cancelling routine instance | routineId=${snapshot.routineId} eventId=${routine.calendarEventId} originalDate=${originalDate} status=${snapshot.status}`,
    );
    await provider.cancelRecurringInstance(routine.calendarEventId, originalDate, config.calendarId);
    await stampItemLastPushed(userId, snapshot._id);
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
async function pushExistingItemToGCal(snapshot: ItemInterface, userId: string, buildProvider: ProviderFactory): Promise<void> {
    const eventId = snapshot.calendarEventId;
    const itemId = snapshot._id;
    if (!eventId || !itemId) {
        return;
    }

    const link: CalendarLink = { integrationId: snapshot.calendarIntegrationId, configId: snapshot.calendarSyncConfigId };
    const ctx = await resolvePushContext(link, userId, buildProvider);
    if (!ctx) {
        return;
    }

    const { provider, config, timeZone } = ctx;

    if (snapshot.status === 'trash' || snapshot.status === 'done') {
        console.log(`[gcal-pushback] deleting GCal event | eventId=${eventId} itemId=${itemId} title=${snapshot.title}`);
        await provider.deleteEvent(config.calendarId, eventId);
        await stampItemLastPushed(userId, itemId);
        return;
    }

    console.log(`[gcal-pushback] updating existing item | eventId=${eventId} title=${snapshot.title} status=${snapshot.status}`);
    await provider.updateEvent(
        config.calendarId,
        eventId,
        {
            title: snapshot.title,
            ...(snapshot.timeStart ? { timeStart: snapshot.timeStart } : {}),
            ...(snapshot.timeEnd ? { timeEnd: snapshot.timeEnd } : {}),
            description: snapshot.notes != null ? markdownToHtml(snapshot.notes) : '',
        },
        timeZone,
    );
    const htmlForSync = snapshot.notes != null ? markdownToHtml(snapshot.notes) : undefined;
    await stampItemLastPushed(userId, itemId, htmlForSync);
}

/** Creates a new Google Calendar event for an app-created calendar item. */
async function pushNewItemToGCal(snapshot: ItemInterface, userId: string, buildProvider: ProviderFactory): Promise<void> {
    if (!snapshot.timeStart || !snapshot.timeEnd || !snapshot._id) {
        return;
    }
    // Routine-managed items are represented by the routine's GCal recurring series.
    if (snapshot.routineId) {
        return;
    }

    // Guard against concurrent GCal creation for the same item (e.g. duplicate create ops
    // from back-to-back flush batches). Claim the slot synchronously (before any await) so a
    // second call in the same microtask sees the entry and bails out.
    if (gcalCreationInFlight.has(snapshot._id)) {
        console.log(`[gcal-pushback] item ${snapshot._id} GCal creation already in-flight — skipping`);
        return;
    }
    gcalCreationInFlight.add(snapshot._id);
    try {
        // Re-read from DB: a previous (now-completed) push-back may have already linked this entity.
        const current = await itemsDAO.findByOwnerAndId(snapshot._id, userId);
        if (current?.calendarEventId) {
            console.log(`[gcal-pushback] item ${snapshot._id} already linked to GCal event ${current.calendarEventId} — skipping create`);
            return;
        }

        const ctx = await resolveDefaultPushContext(userId, buildProvider);
        if (!ctx) {
            return;
        }

        const { provider, config, integration, timeZone } = ctx;
        console.log(`[gcal-pushback] creating new GCal event | itemId=${snapshot._id} title=${snapshot.title}`);
        const calendarEventId = await provider.createEvent(
            config.calendarId,
            {
                title: snapshot.title,
                timeStart: snapshot.timeStart,
                timeEnd: snapshot.timeEnd,
                ...(snapshot.notes !== undefined ? { description: markdownToHtml(snapshot.notes) } : {}),
            },
            timeZone,
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
        if (updated) {
            await recordOperation(userId, { entityType: 'item', entityId: snapshot._id, snapshot: updated, opType: 'update', now });
        }
    } catch (err) {
        console.error(`[calendar-pushback] failed to create GCal event for item ${snapshot._id}:`, err);
    } finally {
        gcalCreationInFlight.delete(snapshot._id);
    }
}

// ── Routine push-back ────────────────────────────────────────────────────────

async function handleRoutinePush(snapshot: RoutineInterface, userId: string, opType: OpType, buildProvider: ProviderFactory): Promise<void> {
    if (opType === 'delete') {
        await pushRoutineDeletion(snapshot, userId, buildProvider);
        return;
    }
    if (snapshot.calendarEventId) {
        await pushExistingRoutineToGCal(snapshot, userId, buildProvider);
        return;
    }
    await pushNewRoutineToGCal(snapshot, userId, buildProvider);
}

/**
 * Cascades a routine delete: removes the GCal master recurring event (if any) and trashes
 * every generated `calendar`-status item so the app-side calendar doesn't keep rendering
 * occurrences of a routine that no longer exists. Each trashed item records its own
 * server-origin update op so other devices converge via the sync pull.
 * GCal deletion is best-effort — a provider failure does not block the item cascade.
 */
async function pushRoutineDeletion(snapshot: RoutineInterface, userId: string, buildProvider: ProviderFactory): Promise<void> {
    await trashGeneratedCalendarItems(snapshot._id, userId);
    if (!snapshot.calendarEventId) {
        return;
    }
    const link: CalendarLink = { integrationId: snapshot.calendarIntegrationId, configId: snapshot.calendarSyncConfigId };
    const ctx = await resolvePushContext(link, userId, buildProvider);
    if (!ctx) {
        return;
    }
    console.log(`[gcal-pushback] deleting GCal recurring event for routine | routineId=${snapshot._id} eventId=${snapshot.calendarEventId}`);
    try {
        await ctx.provider.deleteRecurringEvent(snapshot.calendarEventId, ctx.config.calendarId);
    } catch (err) {
        console.error(`[calendar-pushback] failed to delete GCal recurring event ${snapshot.calendarEventId} for routine ${snapshot._id}:`, err);
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
    await itemsDAO.updateMany({ user: userId, routineId, status: 'calendar' }, { $set: { status: 'trash', updatedTs: now } });
    // Build the post-update snapshot locally rather than re-reading — saves a round trip and
    // the local merge is equivalent since we control the mutation.
    await Promise.all(
        withId.map((item) =>
            recordOperation(userId, {
                entityType: 'item',
                entityId: item._id,
                snapshot: { ...item, status: 'trash', updatedTs: now },
                opType: 'update',
                now,
            }),
        ),
    );
}

/** Pushes edits to an existing GCal recurring event when the routine already has a calendarEventId. */
async function pushExistingRoutineToGCal(snapshot: RoutineInterface, userId: string, buildProvider: ProviderFactory): Promise<void> {
    const { calendarEventId } = snapshot;
    if (!calendarEventId) {
        return;
    }
    const link: CalendarLink = { integrationId: snapshot.calendarIntegrationId, configId: snapshot.calendarSyncConfigId };
    const ctx = await resolvePushContext(link, userId, buildProvider);
    if (!ctx) {
        return;
    }

    await ctx.provider.updateRecurringEvent(calendarEventId, snapshot, ctx.config.calendarId, ctx.timeZone);
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

    // Guard against concurrent GCal creation for the same routine (e.g. duplicate create ops
    // from back-to-back flush batches). Claim the slot synchronously (before any await) so a
    // second call in the same microtask sees the entry and bails out.
    if (gcalCreationInFlight.has(snapshot._id)) {
        console.log(`[gcal-pushback] routine ${snapshot._id} GCal creation already in-flight — skipping`);
        return;
    }
    gcalCreationInFlight.add(snapshot._id);
    try {
        // Re-read from DB: a previous (now-completed) push-back may have already linked this entity.
        const current = await routinesDAO.findByOwnerAndId(snapshot._id, userId);
        if (current?.calendarEventId) {
            console.log(`[gcal-pushback] routine ${snapshot._id} already linked to GCal event ${current.calendarEventId} — skipping create`);
            return;
        }

        const link: CalendarLink = { integrationId: snapshot.calendarIntegrationId, configId: snapshot.calendarSyncConfigId };
        const ctx = await resolvePushContext(link, userId, buildProvider);
        if (!ctx) {
            return;
        }
        const calendarEventId = await ctx.provider.createRecurringEvent(snapshot, ctx.config.calendarId, ctx.timeZone);
        const now = dayjs().toISOString();
        await routinesDAO.updateOne(
            { _id: snapshot._id, user: userId },
            {
                $set: {
                    calendarEventId,
                    calendarSyncConfigId: ctx.config._id,
                    lastPushedToGCalTs: now,
                    updatedTs: now,
                    ...(snapshot.template.notes !== undefined ? { lastSyncedNotes: markdownToHtml(snapshot.template.notes) } : {}),
                },
            },
        );
        // Record an operation so other devices sync the newly-linked calendar event ID.
        const updated = await routinesDAO.findByOwnerAndId(snapshot._id, userId);
        if (updated) {
            await recordOperation(userId, { entityType: 'routine', entityId: snapshot._id, snapshot: updated, opType: 'update', now });
        }
    } catch (err) {
        console.error(`[calendar-pushback] failed to create recurring event for routine ${snapshot._id}:`, err);
    } finally {
        gcalCreationInFlight.delete(snapshot._id);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resolves the push context for an entity that already has integration/config IDs. */
async function resolvePushContext(link: CalendarLink, userId: string, buildProvider: ProviderFactory): Promise<PushContext | null> {
    if (!link.integrationId) {
        console.warn(`[calendar-pushback] resolvePushContext: no integrationId — skipping`);
        return null;
    }
    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(link.integrationId, userId);
    if (!integration) {
        console.warn(`[calendar-pushback] resolvePushContext: integration ${link.integrationId} not found for user ${userId}`);
        return null;
    }
    const config = link.configId
        ? await calendarSyncConfigsDAO.findByOwnerAndId(link.configId, userId)
        : ((await calendarSyncConfigsDAO.findEnabledByIntegration(link.integrationId)).find((c) => c.isDefault) ?? null);
    if (!config) {
        console.warn(`[calendar-pushback] resolvePushContext: no sync config found (configId=${link.configId ?? 'none'}, integrationId=${link.integrationId})`);
        return null;
    }
    const provider = buildProvider(integration, userId);
    const timeZone = await ensureTimeZone(config, provider);
    return { integration, config, provider, timeZone };
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
