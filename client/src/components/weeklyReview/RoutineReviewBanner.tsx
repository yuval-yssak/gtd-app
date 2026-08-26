import LoopIcon from '@mui/icons-material/Loop';
import ButtonBase from '@mui/material/ButtonBase';
import Typography from '@mui/material/Typography';
import classNames from 'classnames';
import { useNewTabAwareNavigate } from '../../lib/newTabNavigation';
import { formatRoutineSchedule } from '../../lib/rruleUtils';
import type { StoredRoutine } from '../../types/MyDB';
import styles from './RoutineReviewBanner.module.css';

interface RoutineReviewBannerProps {
    /** Undefined when the item carries a routineId whose routine is unknown on this device. */
    routine: StoredRoutine | undefined;
    /** The item deviates from the routine's pattern (a `modified` exception) — labeled apart. */
    isException: boolean;
    /** Falls back to this when the routine itself is unknown — still navigates to its page. */
    routineId: string;
}

/**
 * Review-stage emphasis strip for a routine-generated item, above the embedded editor: names the
 * repetition ("Routine · Every Mon") — or the deviation ("Exception to routine · …") — and clicks
 * through to the routine page.
 */
export function RoutineReviewBanner({ routine, isException, routineId }: RoutineReviewBannerProps) {
    const navigateOrNewTab = useNewTabAwareNavigate();
    const schedule = routine ? formatRoutineSchedule(routine) : null;
    const label = isException ? 'Exception to routine' : 'Routine';

    return (
        <ButtonBase
            className={classNames(styles.banner, { [styles.exception]: isException })}
            onClick={(e) => navigateOrNewTab(e, { to: '/routine/$routineId', params: { routineId } })}
            aria-label={routine ? `${label}: ${routine.title}` : 'Part of a routine'}
            data-testid={isException ? 'reviewRoutineExceptionBanner' : 'reviewRoutineBanner'}
        >
            <LoopIcon fontSize="small" />
            <Typography variant="body2" component="span">
                {schedule ? `${label} · ${schedule}` : 'Part of a routine'}
            </Typography>
        </ButtonBase>
    );
}
