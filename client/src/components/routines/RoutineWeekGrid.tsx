import { useMemo } from 'react';
import { Chip, Text } from '../../designSystem';
import { buildRoutineWeekGrid, WEEK_DAY_LABELS } from '../../lib/routineWeekGrid';
import { formatRoutineSchedule } from '../../lib/rruleUtils';
import type { StoredRoutine } from '../../types/MyDB';
import styles from './RoutineWeekGrid.module.css';

interface RoutineWeekGridProps {
    routines: StoredRoutine[];
    onRoutineSelected: (routine: StoredRoutine, event: React.MouseEvent) => void;
}

// Timed calendar routines lead with their time so a day column reads like a mini agenda.
function entryLabel(routine: StoredRoutine): string {
    const timeOfDay = routine.calendarItemTemplate?.timeOfDay;
    return timeOfDay ? `${timeOfDay} ${routine.title}` : routine.title;
}

/**
 * Whole-week overview of a tab's active routines: Mon–Sun columns hold every routine with a fixed
 * weekly rhythm; everything less frequent (every N days, monthly, annual) lists below with its
 * schedule label.
 */
export function RoutineWeekGrid({ routines, onRoutineSelected }: RoutineWeekGridProps) {
    // Memoized: the parent re-renders per search keystroke, and placement parses one rrule per routine.
    const { days, lessFrequent } = useMemo(() => buildRoutineWeekGrid(routines), [routines]);

    return (
        <div data-testid="routineWeekGrid">
            <div className={styles.scrollContainer}>
                <div className={styles.grid}>
                    {WEEK_DAY_LABELS.map((dayLabel, dayIndex) => (
                        <div key={dayLabel} className={styles.dayColumn} data-testid="routineWeekDayColumn">
                            <Text variant="caption" weight="semibold" className={styles.dayLabel}>
                                {dayLabel}
                            </Text>
                            {days[dayIndex]?.map((routine) => (
                                <Chip
                                    key={routine._id}
                                    label={entryLabel(routine)}
                                    variant="outline"
                                    onClick={(e) => onRoutineSelected(routine, e)}
                                    className={styles.entryChip}
                                    data-testid="routineWeekGridEntry"
                                />
                            ))}
                        </div>
                    ))}
                </div>
            </div>
            {lessFrequent.length > 0 && (
                <div className={styles.lessFrequentSection}>
                    <Text variant="overline" tone="secondary">
                        Less frequent
                    </Text>
                    {lessFrequent.map((routine) => (
                        // A real button: keyboard-focusable like the grid's chip entries.
                        <button
                            key={routine._id}
                            type="button"
                            className={styles.lessFrequentRow}
                            onClick={(e) => onRoutineSelected(routine, e)}
                            data-testid="routineWeekLessFrequentRow"
                        >
                            <Text as="span" variant="bodySm">
                                {routine.title}
                            </Text>
                            <Text variant="caption" tone="secondary">
                                {formatRoutineSchedule(routine)}
                            </Text>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
