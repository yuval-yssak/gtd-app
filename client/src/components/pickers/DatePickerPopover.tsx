import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Chip, IconButton, Popover, Text } from '../../designSystem';
import {
    dayCellLabel,
    dayOfMonth,
    isInMonth,
    monthGridWeeks,
    monthHeading,
    quickDatePicks,
    shiftMonth,
    startOfMonthIso,
    weekdayLabels,
} from '../../lib/datePickerGrid';
import { getTodayIso } from '../../lib/dayClock';
import styles from './DateField.module.css';

interface PanelProps {
    /** Current field value (`YYYY-MM-DD` or empty). */
    value: string;
    onPick: (dateIso: string) => void;
    /** Injectable for deterministic tests; defaults to the app day clock. */
    todayIso?: string | undefined;
}

/**
 * Quick-pick chips plus a month grid. Mounted fresh each time the popover opens, so the visible
 * month re-seeds from the current value without an effect.
 */
export function DatePickerPanel({ value, onPick, todayIso = getTodayIso() }: PanelProps) {
    const [monthIso, setMonthIso] = useState(() => startOfMonthIso(value, todayIso));
    return (
        <div className={styles.panel} data-testid="datePickerPanel">
            <div className={styles.quickPicks}>
                {quickDatePicks(todayIso).map((pick) => (
                    <Chip key={pick.label} label={pick.label} size="sm" variant="outline" selected={pick.date === value} onClick={() => onPick(pick.date)} />
                ))}
            </div>
            <div className={styles.monthHeader}>
                <IconButton aria-label="Previous month" size="sm" onClick={() => setMonthIso(shiftMonth(monthIso, -1))}>
                    <ChevronLeft />
                </IconButton>
                <Text as="span" variant="subtitleSm" data-testid="datePickerMonth">
                    {monthHeading(monthIso)}
                </Text>
                <IconButton aria-label="Next month" size="sm" onClick={() => setMonthIso(shiftMonth(monthIso, 1))}>
                    <ChevronRight />
                </IconButton>
            </div>
            <MonthGrid monthIso={monthIso} value={value} todayIso={todayIso} onPick={onPick} />
        </div>
    );
}

interface MonthGridProps {
    monthIso: string;
    value: string;
    todayIso: string;
    onPick: (dateIso: string) => void;
}

function MonthGrid({ monthIso, value, todayIso, onPick }: MonthGridProps) {
    return (
        <div className={styles.grid}>
            {weekdayLabels().map((label) => (
                <span key={label} className={styles.weekday} aria-hidden="true">
                    {label}
                </span>
            ))}
            {monthGridWeeks(monthIso)
                .flat()
                .map((dayIso) => (
                    <button
                        key={dayIso}
                        type="button"
                        className={styles.day}
                        data-outside={!isInMonth(dayIso, monthIso) || undefined}
                        data-today={dayIso === todayIso || undefined}
                        data-selected={dayIso === value || undefined}
                        aria-label={dayCellLabel(dayIso)}
                        aria-pressed={dayIso === value}
                        onClick={() => onPick(dayIso)}
                    >
                        {dayOfMonth(dayIso)}
                    </button>
                ))}
        </div>
    );
}

interface PopoverProps {
    anchorEl: HTMLElement | null;
    value: string;
    onPick: (dateIso: string) => void;
    onClose: () => void;
}

/** Anchored picker for DateField — the panel unmounts on close, which is what resets its month. */
export function DatePickerPopover({ anchorEl, value, onPick, onClose }: PopoverProps) {
    return (
        <Popover open={anchorEl !== null} anchor={anchorEl} onClose={onClose} align="end" aria-label="Pick a date">
            <DatePickerPanel value={value} onPick={onPick} />
        </Popover>
    );
}
