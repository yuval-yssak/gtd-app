import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import calendarIntegrationsDAO from '../../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../../dataAccess/calendarSyncConfigsDAO.js';
import routinesDAO from '../../dataAccess/routinesDAO.js';
import { db } from '../../loaders/mainLoader.js';
import type { CalendarIntegrationInterface, CalendarSyncConfigInterface, RoutineInterface } from '../../types/entities.js';
import { loadSecrets } from './env.js';
import { gcalCalendarId, getTimeZone } from './gcal.js';

export interface SeedResult {
    userId: string;
    integration: CalendarIntegrationInterface;
    config: CalendarSyncConfigInterface;
    timeZone: string;
}

/** Ensures a deterministic test user exists; returns the userId. */
async function ensureUser(email: string): Promise<string> {
    const existing = await db.collection<{ _id: string; email: string }>('user').findOne({ email });
    if (existing) return existing._id;
    const userId = `sync-audit-${randomUUID()}`;
    const now = dayjs().toDate();
    await db.collection('user').insertOne({
        _id: userId,
        email,
        name: email.split('@')[0] ?? 'sync-audit',
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
    } as never);
    return userId;
}

/**
 * Wipes every entity tied to sync-audit users and reseeds a fresh integration
 * pointing at the real test Google Calendar account.
 *
 * The `accessToken` stored is a placeholder; googleapis silently refreshes it
 * on first API call using the stored `refreshToken`.
 */
export async function seedFreshAccount(): Promise<SeedResult> {
    const secrets = loadSecrets();
    const email = `sync-audit-${secrets.email.replace('@', '-at-')}`;
    const userId = await ensureUser(email);
    const now = dayjs().toISOString();

    // Wipe user-scoped state. Keep the user row itself so session lookups keep working
    // across runs — nothing references it beyond our seed-time query.
    // The DAO abstraction doesn't expose deleteMany, so we use the raw db handle.
    await Promise.all([
        db.collection('items').deleteMany({ user: userId }),
        db.collection('routines').deleteMany({ user: userId }),
        db.collection('operations').deleteMany({ user: userId }),
        db.collection('calendarIntegrations').deleteMany({ user: userId }),
        db.collection('calendarSyncConfigs').deleteMany({ user: userId }),
        db.collection('session').deleteMany({ userId }),
    ]);

    const integrationId = `sync-audit-int-${randomUUID()}`;
    const integration: CalendarIntegrationInterface = {
        _id: integrationId,
        user: userId,
        provider: 'google',
        // Placeholder — googleapis will refresh on first call using the refresh token below.
        accessToken: 'placeholder-access-token',
        refreshToken: secrets.refreshToken,
        tokenExpiry: dayjs().subtract(1, 'hour').toISOString(), // force immediate refresh
        calendarId: gcalCalendarId(),
        createdTs: now,
        updatedTs: now,
    };
    await calendarIntegrationsDAO.insertEncrypted(integration);

    const timeZone = await getTimeZone();
    const config: CalendarSyncConfigInterface = {
        _id: `sync-audit-cfg-${randomUUID()}`,
        integrationId,
        user: userId,
        calendarId: gcalCalendarId(),
        isDefault: true,
        enabled: true,
        timeZone,
        createdTs: now,
        updatedTs: now,
    };
    await calendarSyncConfigsDAO.insertOne(config);

    return { userId, integration, config, timeZone };
}

export interface SeedRoutineArgs {
    userId: string;
    integrationId: string;
    configId: string;
    title: string;
    rrule: string;
    timeOfDay: string;
    duration: number;
    notes?: string;
    calendarEventId?: string;
}

/** Inserts a calendar routine directly into Mongo (no GCal side effect). */
export async function seedRoutine(args: SeedRoutineArgs): Promise<RoutineInterface> {
    const now = dayjs().toISOString();
    const routine: RoutineInterface = {
        _id: `sync-audit-routine-${randomUUID()}`,
        user: args.userId,
        title: args.title,
        routineType: 'calendar',
        rrule: args.rrule,
        template: args.notes !== undefined ? { notes: args.notes } : {},
        active: true,
        createdTs: now,
        updatedTs: now,
        calendarItemTemplate: { timeOfDay: args.timeOfDay, duration: args.duration },
        calendarIntegrationId: args.integrationId,
        calendarSyncConfigId: args.configId,
        ...(args.calendarEventId ? { calendarEventId: args.calendarEventId } : {}),
    };
    await routinesDAO.insertOne(routine);
    return routine;
}
