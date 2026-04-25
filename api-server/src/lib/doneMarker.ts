/**
 * Sync layer ownership: an item's stored `title` always stays clean. The marker is applied only
 * when pushing a `done` item to GCal, and stripped only when reading back a GCal event whose
 * matching local item already has `status: 'done'`.
 */

export const DONE_PREFIX = '✓ ';

// GCal palette ID for "Sage". See https://developers.google.com/calendar/api/v3/reference/colors.
export const DONE_COLOR_ID = '2';

export function applyDoneMarker(title: string): string {
    if (title.startsWith(DONE_PREFIX)) {
        return title;
    }
    return `${DONE_PREFIX}${title}`;
}

export function stripDoneMarker(title: string): string {
    if (title.startsWith(DONE_PREFIX)) {
        return title.slice(DONE_PREFIX.length);
    }
    return title;
}
