import EventIcon from '@mui/icons-material/Event';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PlaceIcon from '@mui/icons-material/Place';
import VideocamIcon from '@mui/icons-material/Videocam';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
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
        <Box className={styles.container} data-testid="calendarEventLinks">
            {calendarName && (
                <Box className={styles.field}>
                    <Typography variant="caption" color="text.secondary">
                        Calendar
                    </Typography>
                    <Typography variant="body2" data-testid="calendarName">
                        {calendarName}
                    </Typography>
                </Box>
            )}
            {meetingLink && (
                <Box className={styles.linkRow}>
                    <VideocamIcon className={styles.icon} color="action" />
                    <Link href={meetingLink} target="_blank" rel="noopener noreferrer" variant="body2" data-testid="meetingLinkButton">
                        {meetingLinkLabel(meetingLink)}
                    </Link>
                </Box>
            )}
            {location && (
                <Box className={styles.locationRow}>
                    <PlaceIcon className={styles.icon} color="action" />
                    {isUrl(location) ? (
                        <Link href={location} target="_blank" rel="noopener noreferrer" variant="body2" data-testid="eventLocation">
                            {location}
                        </Link>
                    ) : (
                        <Typography variant="body2" data-testid="eventLocation">
                            {location}
                        </Typography>
                    )}
                </Box>
            )}
            {htmlLink && (
                <Box className={styles.linkRow}>
                    <EventIcon className={styles.icon} color="action" />
                    <Link href={htmlLink} target="_blank" rel="noopener noreferrer" variant="body2" data-testid="openInGCalLink">
                        Open in Google Calendar
                        <OpenInNewIcon className={styles.icon} color="action" />
                    </Link>
                </Box>
            )}
        </Box>
    );
}
