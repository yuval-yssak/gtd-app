import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import type { CalendarSyncConfigInterface, GCalAttendee, GCalResponseStatus, ItemInterface } from '../types/entities.js';

/**
 * Computes the next attendees array for an RSVP. Finds the self entry by case-insensitive email
 * match and updates its responseStatus; if no self entry exists yet, appends one. Sorts by email
 * to match the parser's stable ordering policy so equality with subsequent inbound pulls is exact.
 *
 * Shared between the online-fast-path endpoint (calendar.ts) and the offline replay path
 * (rsvpReplay.ts).
 */
export function applyRsvpToAttendees(existing: readonly GCalAttendee[], myEmail: string, responseStatus: GCalResponseStatus): GCalAttendee[] {
    const normalized = myEmail.toLowerCase();
    const selfIndex = existing.findIndex((a) => a.email.toLowerCase() === normalized);
    const next = existing.map((a) => ({ ...a }));
    if (selfIndex >= 0) {
        const current = next[selfIndex];
        if (current) {
            next[selfIndex] = { ...current, responseStatus };
        }
    } else {
        next.push({ email: myEmail, responseStatus, self: true });
    }
    return next.sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * Looks up the sync config that owns this item's GCal event. We don't store `calendarSyncConfigId`
 * on every item (legacy items lack it), so fall back to the integration's default config.
 *
 * Shared between the online-fast-path endpoint (calendar.ts) and the offline replay path
 * (rsvpReplay.ts).
 */
export async function resolveSyncConfigForItem(item: ItemInterface, integrationId: string, userId: string): Promise<CalendarSyncConfigInterface | null> {
    if (item.calendarSyncConfigId) {
        const config = await calendarSyncConfigsDAO.findByOwnerAndId(item.calendarSyncConfigId, userId);
        if (config) {
            return config;
        }
    }
    const configs = await calendarSyncConfigsDAO.findEnabledByIntegration(integrationId);
    return configs.find((c) => c.isDefault) ?? configs[0] ?? null;
}
