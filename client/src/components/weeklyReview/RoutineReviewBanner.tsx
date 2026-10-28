import { Repeat } from 'lucide-react';
import { Text } from '../../designSystem';
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
    /** Trailing context after the schedule — the collapsed routine card's series tail ("41 more after this one"). */
    detail?: string;
}

/**
 * Review-stage emphasis strip for a routine-generated item, above the embedded editor: names the
 * repetition ("Routine · Every Mon") — or the deviation ("Exception to routine · …") — and clicks
 * through to the routine page.
 */
export function RoutineReviewBanner({ routine, isException, routineId, detail }: RoutineReviewBannerProps) {
    const navigateOrNewTab = useNewTabAwareNavigate();
    const schedule = routine ? formatRoutineSchedule(routine) : null;
    const label = isException ? 'Exception to routine' : 'Routine';
    const text = schedule ? [`${label} · ${schedule}`, detail].filter(Boolean).join(' · ') : 'Part of a routine';

    return (
        <button
            type="button"
            className={styles.banner}
            data-exception={isException || undefined}
            onClick={(e) => navigateOrNewTab(e, { to: '/routine/$routineId', params: { routineId } })}
            aria-label={routine ? `${label}: ${routine.title}` : 'Part of a routine'}
            data-testid={isException ? 'reviewRoutineExceptionBanner' : 'reviewRoutineBanner'}
        >
            <Repeat size={18} />
            <Text as="span" variant="bodySm" tone="inherit">
                {text}
            </Text>
        </button>
    );
}
