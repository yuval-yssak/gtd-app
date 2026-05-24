import PeopleOutlineIcon from '@mui/icons-material/PeopleOutlined';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import classNames from 'classnames';
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
    const theme = useTheme();
    const isDesktop = useMediaQuery(theme.breakpoints.up('sm'));

    if (!shouldRenderMeta(item)) return null;

    const count = getAttendeeCount(item);
    const selfStatus = getSelfResponseStatus(item);
    const organizerLabel = getOrganizerDisplay(item);

    return (
        <Box className={styles.root} data-testid="calendarRowMeta">
            {count > 0 && (
                <Tooltip title={`${count} ${count === 1 ? 'attendee' : 'attendees'}`}>
                    <Box className={styles.countGroup} data-testid="calendarRowMetaCount">
                        <PeopleOutlineIcon fontSize="small" />
                        <Typography variant="caption">{count}</Typography>
                        {selfStatus && <RsvpDot status={selfStatus} />}
                    </Box>
                </Tooltip>
            )}
            {isDesktop && organizerLabel && (
                <Tooltip title={item.organizer?.email ?? organizerLabel}>
                    <Typography variant="caption" className={styles.organizer} data-testid="calendarRowMetaOrganizer">
                        {organizerLabel}
                    </Typography>
                </Tooltip>
            )}
        </Box>
    );
}

interface RsvpDotProps {
    status: GCalResponseStatus;
}

function RsvpDot({ status }: RsvpDotProps) {
    const color = rsvpDotColorFor(status);
    const colorClass = colorClassFor(color);
    // role="img" lets us attach aria-label to the otherwise-decorative span — Biome's a11y rule
    // requires a recognized role before custom ARIA props are accepted on a generic element.
    return (
        <span className={classNames(styles.rsvpDot, colorClass)} data-testid={`calendarRowMetaRsvpDot-${status}`} role="img" aria-label={`RSVP: ${status}`} />
    );
}

/** Maps the palette key to its CSS Module class. `default` keeps the base gray dot. */
function colorClassFor(color: 'success' | 'error' | 'warning' | 'default'): string | undefined {
    if (color === 'success') return styles.rsvpDotAccepted;
    if (color === 'error') return styles.rsvpDotDeclined;
    if (color === 'warning') return styles.rsvpDotTentative;
    return undefined;
}
