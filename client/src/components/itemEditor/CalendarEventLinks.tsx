import { CalendarDays, ExternalLink, MapPin, Video } from 'lucide-react';
import { Text } from '../../designSystem';
import type { CalendarOption } from '../../hooks/useCalendarOptions';
import type { StoredItem } from '../../types/MyDB';
import styles from './CalendarEventLinks.module.css';

interface CalendarEventLinksProps {
    item: StoredItem;
    /** Resolved calendar options (passed in to avoid a duplicate useCalendarOptions() fetch). */
    calendarOptions: CalendarOption[];
}

/**
 * Returns the join-button label inferred from the meeting-link host: "Join Google Meet" for
 * meet.google.com, "Join Zoom" for zoom.us, otherwise a provider-agnostic "Join meeting". Falls
 * back to the generic label when the URL is unparseable rather than throwing.
 */
export function meetingLinkLabel(url: string): string {
    try {
        const { hostname } = new URL(url);
        if (hostname === 'meet.google.com') return 'Join Google Meet';
        if (hostname === 'zoom.us' || hostname.endsWith('.zoom.us')) return 'Join Zoom';
        return 'Join meeting';
    } catch {
        return 'Join meeting';
    }
}

/** True when the location string parses as an http(s) URL — render it as a link rather than text. */
export function isUrl(value: string): boolean {
    try {
        const { protocol } = new URL(value);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

/** Resolves the human-readable calendar name from the item's sync-config id, falling back to the id. */
export function resolveCalendarName(item: StoredItem, calendarOptions: CalendarOption[]): string | undefined {
    if (!item.calendarSyncConfigId) {
        return undefined;
    }
    const match = calendarOptions.find((option) => option.configId === item.calendarSyncConfigId);
    return match?.displayName ?? item.calendarSyncConfigId;
}

/**
 * Read-only "event info" block for a GCal-linked calendar item: which calendar it lives on, the
 * conferencing join link, the location, and an "open in Google Calendar" deep link. All four fields
 * are GCal-owned and never edited in-app. Self-suppresses (renders null) when none resolve, so the
 * caller can mount it unconditionally.
 */
export function CalendarEventLinks({ item, calendarOptions }: CalendarEventLinksProps) {
    const calendarName = resolveCalendarName(item, calendarOptions);
    const { meetingLink, location, htmlLink } = item;

    if (!calendarName && !meetingLink && !location && !htmlLink) {
        return null;
    }

    return (
        <div className={styles.container} data-testid="calendarEventLinks">
            {calendarName && (
                <div className={styles.field}>
                    <Text as="span" variant="caption" tone="secondary">
                        Calendar
                    </Text>
                    <Text variant="bodySm" data-testid="calendarName">
                        {calendarName}
                    </Text>
                </div>
            )}
            {meetingLink && (
                <div className={styles.linkRow}>
                    <Video className={styles.icon} aria-hidden="true" />
                    <a href={meetingLink} target="_blank" rel="noopener noreferrer" className={styles.link} data-testid="meetingLinkButton">
                        {meetingLinkLabel(meetingLink)}
                    </a>
                </div>
            )}
            {location && (
                <div className={styles.locationRow}>
                    <MapPin className={styles.icon} aria-hidden="true" />
                    {isUrl(location) ? (
                        <a href={location} target="_blank" rel="noopener noreferrer" className={styles.link} data-testid="eventLocation">
                            {location}
                        </a>
                    ) : (
                        <Text variant="bodySm" data-testid="eventLocation">
                            {location}
                        </Text>
                    )}
                </div>
            )}
            {htmlLink && (
                <div className={styles.linkRow}>
                    <CalendarDays className={styles.icon} aria-hidden="true" />
                    <a href={htmlLink} target="_blank" rel="noopener noreferrer" className={styles.link} data-testid="openInGCalLink">
                        Open in Google Calendar
                        <ExternalLink className={styles.icon} aria-hidden="true" />
                    </a>
                </div>
            )}
        </div>
    );
}
