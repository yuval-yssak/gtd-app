import dayjs from 'dayjs';
import type { CalendarProvider } from '../calendarProviders/CalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import type { CalendarIntegrationInterface, CalendarSyncConfigInterface, ItemInterface, OperationInterface, RoutineInterface } from '../types/entities.js';
import { recordOperation } from './operationHelpers.js';

type ProviderFactory = (integration: CalendarIntegrationInterface, userId: string) => CalendarProvider;

/** Resolved calendar context for push-back: decrypted integration, sync config, and provider. */
interface PushContext {
    integration: CalendarIntegrationInterface;
    config: CalendarSyncConfigInterface;
    provider: CalendarProvider;
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
    if (op.entityType === 'item' && op.snapshot) {
        await handleItemPush(op.snapshot as ItemInterface, op.user, buildProvider);
        return;
    }
    if (op.entityType === 'routine' && op.snapshot) {
        await handleRoutinePush(op.snapshot as RoutineInterface, op.user, buildProvider);
    }
}

// ── Item push-back ───────────────────────────────────────────────────────────

async function handleItemPush(snapshot: ItemInterface, userId: string, buildProvider: ProviderFactory): Promise<void> {
    if (snapshot.calendarEventId) {
        await pushExistingItemToGCal(snapshot, userId, buildProvider);
        return;
    }
    if (snapshot.status === 'calendar') {
        await pushNewItemToGCal(snapshot, userId, buildProvider);
    }
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

    const { provider, config } = ctx;

    if (snapshot.status === 'trash' || snapshot.status === 'done') {
        await provider.deleteEvent(config.calendarId, eventId);
        await stampItemLastPushed(userId, itemId);
        return;
    }

    await provider.updateEvent(config.calendarId, eventId, {
        title: snapshot.title,
        ...(snapshot.timeStart ? { timeStart: snapshot.timeStart } : {}),
        ...(snapshot.timeEnd ? { timeEnd: snapshot.timeEnd } : {}),
    });
    await stampItemLastPushed(userId, itemId);
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

    const ctx = await resolveDefaultPushContext(userId, buildProvider);
    if (!ctx) {
        return;
    }

    const { provider, config, integration } = ctx;
    const calendarEventId = await provider.createEvent(config.calendarId, {
        title: snapshot.title,
        timeStart: snapshot.timeStart,
        timeEnd: snapshot.timeEnd,
    });

    const now = dayjs().toISOString();
    await itemsDAO.updateOne(
        { _id: snapshot._id, user: userId },
        { $set: { calendarEventId, calendarIntegrationId: integration._id, calendarSyncConfigId: config._id, lastPushedToGCalTs: now, updatedTs: now } },
    );
    // Record an operation so other devices learn about the newly-linked calendar event ID.
    const updated = await itemsDAO.findByOwnerAndId(snapshot._id, userId);
    if (updated) {
        await recordOperation(userId, { entityType: 'item', entityId: snapshot._id, snapshot: updated, opType: 'update', now });
    }
}

// ── Routine push-back ────────────────────────────────────────────────────────

async function handleRoutinePush(snapshot: RoutineInterface, userId: string, buildProvider: ProviderFactory): Promise<void> {
    if (snapshot.calendarEventId) {
        await pushExistingRoutineToGCal(snapshot, userId, buildProvider);
        return;
    }
    await pushNewRoutineToGCal(snapshot, userId, buildProvider);
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

    await ctx.provider.updateRecurringEvent(calendarEventId, snapshot, ctx.config.calendarId);
    await stampRoutineLastPushed(userId, snapshot._id);
}

/** Creates a new GCal recurring event for a calendar routine that isn't linked yet. */
async function pushNewRoutineToGCal(snapshot: RoutineInterface, userId: string, buildProvider: ProviderFactory): Promise<void> {
    if (snapshot.routineType !== 'calendar' || !snapshot.calendarIntegrationId) {
        return;
    }

    const link: CalendarLink = { integrationId: snapshot.calendarIntegrationId, configId: snapshot.calendarSyncConfigId };
    const ctx = await resolvePushContext(link, userId, buildProvider);
    if (!ctx) {
        return;
    }

    try {
        const calendarEventId = await ctx.provider.createRecurringEvent(snapshot, ctx.config.calendarId);
        const now = dayjs().toISOString();
        await routinesDAO.updateOne(
            { _id: snapshot._id, user: userId },
            { $set: { calendarEventId, calendarSyncConfigId: ctx.config._id, lastPushedToGCalTs: now, updatedTs: now } },
        );
        // Record an operation so other devices sync the newly-linked calendar event ID.
        const updated = await routinesDAO.findByOwnerAndId(snapshot._id, userId);
        if (updated) {
            await recordOperation(userId, { entityType: 'routine', entityId: snapshot._id, snapshot: updated, opType: 'update', now });
        }
    } catch (err) {
        console.error(`[calendar-pushback] failed to create recurring event for routine ${snapshot._id}:`, err);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resolves the push context for an entity that already has integration/config IDs. */
async function resolvePushContext(link: CalendarLink, userId: string, buildProvider: ProviderFactory): Promise<PushContext | null> {
    if (!link.integrationId) {
        return null;
    }
    const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(link.integrationId, userId);
    if (!integration) {
        return null;
    }
    const config = link.configId
        ? await calendarSyncConfigsDAO.findByOwnerAndId(link.configId, userId)
        : ((await calendarSyncConfigsDAO.findEnabledByIntegration(link.integrationId)).find((c) => c.isDefault) ?? null);
    if (!config) {
        return null;
    }
    return { integration, config, provider: buildProvider(integration, userId) };
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
    return { integration, config: defaultConfig, provider: buildProvider(integration, userId) };
}

/** Stamps `lastPushedToGCalTs` on an item so the inbound sync can detect its own echo. */
async function stampItemLastPushed(userId: string, itemId: string): Promise<void> {
    const now = dayjs().toISOString();
    await itemsDAO.updateOne({ _id: itemId, user: userId }, { $set: { lastPushedToGCalTs: now, updatedTs: now } });
}

/** Stamps `lastPushedToGCalTs` on a routine so the inbound sync can detect its own echo. */
async function stampRoutineLastPushed(userId: string, routineId: string): Promise<void> {
    const now = dayjs().toISOString();
    await routinesDAO.updateOne({ _id: routineId, user: userId }, { $set: { lastPushedToGCalTs: now, updatedTs: now } });
}
