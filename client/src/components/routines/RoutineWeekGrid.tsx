import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import ListItemButton from '@mui/material/ListItemButton';
import Typography from '@mui/material/Typography';
import { useMemo } from 'react';
import { buildRoutineWeekGrid, WEEK_DAY_LABELS } from '../../lib/routineWeekGrid';
import { formatRoutineSchedule } from '../../lib/rruleUtils';
import type { StoredRoutine } from '../../types/MyDB';
import styles from './RoutineWeekGrid.module.css';

interface RoutineWeekGridProps {
    routines: StoredRoutine[];
    onRoutineSelected: (routine: StoredRoutine) => void;
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
        <Box data-testid="routineWeekGrid">
            <Box className={styles.scrollContainer}>
                <Box className={styles.grid}>
                    {WEEK_DAY_LABELS.map((dayLabel, dayIndex) => (
                        <Box key={dayLabel} className={styles.dayColumn} data-testid="routineWeekDayColumn">
                            <Typography variant="caption" className={styles.dayLabel}>
                                {dayLabel}
                            </Typography>
                            {days[dayIndex]?.map((routine) => (
                                <Chip
                                    key={routine._id}
                                    label={entryLabel(routine)}
                                    size="small"
                                    variant="outlined"
                                    onClick={() => onRoutineSelected(routine)}
                                    className={styles.entryChip}
                                    data-testid="routineWeekGridEntry"
                                />
                            ))}
                        </Box>
                    ))}
                </Box>
            </Box>
            {lessFrequent.length > 0 && (
                <Box className={styles.lessFrequentSection}>
                    <Typography
                        variant="overline"
                        sx={{
                            color: 'text.secondary',
                        }}
                    >
                        Less frequent
                    </Typography>
                    {lessFrequent.map((routine) => (
                        // ListItemButton (not a bare Box): keyboard-focusable like the grid's Chip entries.
                        <ListItemButton
                            key={routine._id}
                            className={styles.lessFrequentRow}
                            onClick={() => onRoutineSelected(routine)}
                            data-testid="routineWeekLessFrequentRow"
                        >
                            <Typography variant="body2">{routine.title}</Typography>
                            <Typography
                                variant="caption"
                                sx={{
                                    color: 'text.secondary',
                                }}
                            >
                                {formatRoutineSchedule(routine)}
                            </Typography>
                        </ListItemButton>
                    ))}
                </Box>
            )}
        </Box>
    );
}
