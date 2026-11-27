/**
 * What a trash of an item does in Google Calendar, as an API caller sees it — predicted by
 * `predictTrashGoogleEffect` in calendarPushback.ts, which runs pushback's own trash guards.
 * `googleSyncPaused`: the item IS synced, but its integration is suspended or revoked, so the
 * push is dropped and the event stays in Google.
 */
export type TrashGoogleEffect = 'eventDeleted' | 'occurrenceCancelled' | 'googleSyncPaused';

/** The sentence the caller relays to the user. Progressive tense: the Google push runs after the response. */
export const TRASH_GOOGLE_NOTICES: Record<TrashGoogleEffect, string> = {
    eventDeleted: 'This item was synced with Google Calendar, so its Google Calendar event is being deleted too.',
    occurrenceCancelled:
        'This item is an occurrence of a routine synced with Google Calendar, so that occurrence is being cancelled in Google Calendar too; the rest of the series stays.',
    googleSyncPaused:
        'This item is synced with Google Calendar, but sync is paused for that account, so the event stays in Google Calendar. Reconnect Google Calendar in Done’s Settings, or delete the event in Google Calendar.',
};
