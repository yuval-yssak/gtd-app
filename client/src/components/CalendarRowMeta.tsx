import { Users } from 'lucide-react';
import { Text, Tooltip } from '../designSystem';
import { AT_LEAST_SM_QUERY, useMediaQuery } from '../hooks/useIsMobile';
import type { GCalResponseStatus, StoredItem } from '../types/MyDB';
import styles from './CalendarRowMeta.module.css';
import { getAttendeeCount, getOrganizerDisplay, getSelfResponseStatus, rsvpDotColorFor, shouldRenderMeta } from './calendarRowMetaLogic';

interface Props {
    item: StoredItem;
}

/**
 * Compact meta line rendered to the right of a calendar item's title. Shows attendee count + RSVP
 * dot (always when attendees exist) and the organizer name (on >=sm breakpoints only — kept off
 * mobile so the row doesn't overflow). Returns null when neither data point is available.
 */
export function CalendarRowMeta({ item }: Props) {
    const isDesktop = useMediaQuery(AT_LEAST_SM_QUERY);

    if (!shouldRenderMeta(item)) return null;

    const count = getAttendeeCount(item);
    const selfStatus = getSelfResponseStatus(item);
    const organizerLabel = getOrganizerDisplay(item);

    return (
        <div className={styles.root} data-testid="calendarRowMeta">
            {count > 0 && (
                <Tooltip title={`${count} ${count === 1 ? 'attendee' : 'attendees'}`}>
                    <span className={styles.countGroup} data-testid="calendarRowMetaCount">
                        <Users size={16} aria-hidden="true" />
                        <Text variant="caption" tone="inherit">
                            {count}
                        </Text>
                        {selfStatus && <RsvpDot status={selfStatus} />}
                    </span>
                </Tooltip>
            )}
            {isDesktop && organizerLabel && (
                <Tooltip title={item.organizer?.email ?? organizerLabel}>
                    <Text variant="caption" tone="inherit" className={styles.organizer} data-testid="calendarRowMetaOrganizer">
                        {organizerLabel}
                    </Text>
                </Tooltip>
            )}
        </div>
    );
}

interface RsvpDotProps {
    status: GCalResponseStatus;
}

function RsvpDot({ status }: RsvpDotProps) {
    return (
        <span
            className={styles.rsvpDot}
            data-rsvp={rsvpDotColorFor(status)}
            data-testid={`calendarRowMetaRsvpDot-${status}`}
            // role="img" lets us attach aria-label to the otherwise-decorative span — Biome's a11y rule requires
            // a recognized role before custom ARIA props are accepted on a generic element.
            role="img"
            aria-label={`RSVP: ${status}`}
        />
    );
}
