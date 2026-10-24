import dayjs from 'dayjs';
import { useState } from 'react';
import { Chip, RadioGroup, type RadioOption, Text, TextField, ToggleGroup } from '../../designSystem';
import { computeNextOccurrence, deriveRecurrenceAnchor } from '../../lib/rruleUtils';
import styles from './FrequencyPicker.module.css';

type FreqMode = 'daily' | 'weekly' | 'monthly' | 'yearly';
type RecurrenceAnchor = 'floating' | 'fixed';

interface FreqState {
    mode: FreqMode;
    intervalDays: number;
    selectedDays: string[]; // RFC 5545 BYDAY values: 'MO','TU','WE','TH','FR','SA','SU'
    intervalWeeks: number;
    dayOfMonth: number;
    intervalMonths: number;
    recurrenceAnchor: RecurrenceAnchor;
}

const DAYS = [
    { key: 'MO', label: 'Mon' },
    { key: 'TU', label: 'Tue' },
    { key: 'WE', label: 'Wed' },
    { key: 'TH', label: 'Thu' },
    { key: 'FR', label: 'Fri' },
    { key: 'SA', label: 'Sat' },
    { key: 'SU', label: 'Sun' },
] as const;

const MODE_LABELS: Record<FreqMode, string> = {
    daily: 'Every X days',
    weekly: 'Specific days of the week',
    monthly: 'Day of month',
    yearly: 'Every year',
};

// Pure helper (exported for unit tests). Toggles `key` in `selectedDays` but keeps at least
// one day selected, so the computed rrule always has a BYDAY clause.
export function computeToggledDays(selectedDays: readonly string[], key: string) {
    const toggled = selectedDays.includes(key) ? selectedDays.filter((d) => d !== key) : [...selectedDays, key];
    return toggled.length > 0 ? toggled : [key];
}

// Simple string-based rrule parser — avoids dealing with rrule.js's complex byweekday union types.
// `recurrenceAnchor` is the routine's stored value (falls back to deriving from the rrule shape
// when undefined — see StoredRoutine.recurrenceAnchor). When floating, dayOfMonth/selectedDays are
// NOT parsed from the rrule — there's nothing to pick, so no fabricated default is produced.
// Exported for unit tests.
export function parseToFreqState(rruleStr: string, recurrenceAnchor?: RecurrenceAnchor): FreqState {
    const defaults: FreqState = {
        mode: 'daily',
        intervalDays: 1,
        selectedDays: ['MO'],
        intervalWeeks: 1,
        dayOfMonth: 1,
        intervalMonths: 1,
        recurrenceAnchor: 'floating',
    };
    if (!rruleStr) return defaults;
    const parts = rruleStr.toUpperCase().split(';');
    const get = (key: string) => parts.find((p) => p.startsWith(`${key}=`))?.split('=')[1];
    const interval = parseInt(get('INTERVAL') ?? '1', 10);
    const freq = get('FREQ');
    const anchor = recurrenceAnchor ?? deriveRecurrenceAnchor(rruleStr);
    if (freq === 'YEARLY') return { ...defaults, mode: 'yearly', recurrenceAnchor: anchor };
    if (freq === 'MONTHLY') {
        return {
            ...defaults,
            mode: 'monthly',
            intervalMonths: interval,
            recurrenceAnchor: anchor,
            ...(anchor === 'fixed' ? { dayOfMonth: parseInt(get('BYMONTHDAY') ?? '1', 10) } : {}),
        };
    }
    if (freq === 'WEEKLY') {
        return {
            ...defaults,
            mode: 'weekly',
            intervalWeeks: interval,
            recurrenceAnchor: anchor,
            ...(anchor === 'fixed' ? { selectedDays: (get('BYDAY') ?? 'MO').split(',').filter(Boolean) } : {}),
        };
    }
    return { ...defaults, mode: 'daily', intervalDays: interval };
}

// Exported for unit tests.
export function buildRrule(state: FreqState): string {
    switch (state.mode) {
        case 'yearly':
            return 'FREQ=YEARLY';
        case 'monthly': {
            const intervalSuffix = state.intervalMonths > 1 ? `;INTERVAL=${state.intervalMonths}` : '';
            if (state.recurrenceAnchor === 'floating') {
                return `FREQ=MONTHLY${intervalSuffix}`;
            }
            return `FREQ=MONTHLY;BYMONTHDAY=${state.dayOfMonth}${intervalSuffix}`;
        }
        case 'weekly': {
            const intervalSuffix = state.intervalWeeks > 1 ? `;INTERVAL=${state.intervalWeeks}` : '';
            if (state.recurrenceAnchor === 'floating') {
                return `FREQ=WEEKLY${intervalSuffix}`;
            }
            const byday = state.selectedDays.length > 0 ? state.selectedDays.join(',') : 'MO';
            return `FREQ=WEEKLY;BYDAY=${byday}${intervalSuffix}`;
        }
        case 'daily': {
            const intervalSuffix = state.intervalDays > 1 ? `;INTERVAL=${state.intervalDays}` : '';
            return `FREQ=DAILY${intervalSuffix}`;
        }
    }
}

function NextDuePreview({ rrule }: { rrule: string }) {
    try {
        const next = computeNextOccurrence(rrule, dayjs().toDate());
        return (
            <Text variant="caption" tone="secondary" className={styles.preview}>
                Next due: {dayjs(next).format('ddd, MMM D, YYYY')}
            </Text>
        );
    } catch {
        return null;
    }
}

interface Props {
    value: string; // rrule string
    recurrenceAnchor?: RecurrenceAnchor; // the routine's stored value — falls back to deriving from `value` when unset
    onChange: (rrule: string, recurrenceAnchor: RecurrenceAnchor) => void;
    disabled?: boolean;
}

const FREQ_MODES = ['daily', 'weekly', 'monthly', 'yearly'] as const satisfies readonly FreqMode[];
const MODE_OPTIONS: RadioOption<FreqMode>[] = FREQ_MODES.map((mode) => ({ value: mode, label: MODE_LABELS[mode] }));

export function FrequencyPicker({ value, recurrenceAnchor, onChange, disabled }: Props) {
    const [state, setState] = useState<FreqState>(() => parseToFreqState(value, recurrenceAnchor));

    // Functional updater: rapid successive clicks (toggle Mon, then Tue before React flushes)
    // used to read a stale `state` closure and lose the first toggle. Reading from `prev` ensures
    // each click composes on top of the latest state.
    function update(patch: Partial<FreqState> | ((prev: FreqState) => Partial<FreqState>)) {
        setState((prev) => {
            const resolved = typeof patch === 'function' ? patch(prev) : patch;
            const next = { ...prev, ...resolved };
            onChange(buildRrule(next), next.recurrenceAnchor);
            return next;
        });
    }

    function toggleDay(key: string) {
        update((prev) => ({ selectedDays: computeToggledDays(prev.selectedDays, key) }));
    }

    const currentRrule = buildRrule(state);

    return (
        <fieldset disabled={disabled} className={styles.root}>
            {/* `disabled` passed explicitly, not left to the fieldset: the DS radios and toggles are
                spans, which a native <fieldset disabled> does not reach. */}
            {/* Unnamed on purpose: the host's "Frequency" legend names the group; a second name would read twice. */}
            <RadioGroup value={state.mode} onValueChange={(mode) => update({ mode })} options={MODE_OPTIONS} disabled={disabled} />
            {/* After the group, not inside it: the day chips and the anchor toggle would otherwise sit
                in the radio group's arrow-key roving focus. */}
            <SubFields mode={state.mode} state={state} onUpdate={update} onToggleDay={toggleDay} disabled={disabled ?? false} />
            <NextDuePreview rrule={currentRrule} />
        </fieldset>
    );
}

interface SubFieldsProps {
    mode: FreqMode;
    state: FreqState;
    onUpdate: (patch: Partial<FreqState>) => void;
    onToggleDay: (key: string) => void;
    disabled: boolean;
}

const RECURRENCE_ANCHOR_CAPTIONS: Record<'monthly' | 'weekly', Record<RecurrenceAnchor, string>> = {
    monthly: {
        floating: 'Next due date = the day you complete it, one month later.',
        fixed: 'Next due date is always the chosen day of the month.',
    },
    weekly: {
        floating: 'Next due date = the day you complete it, one week later.',
        fixed: 'Next due date is always the chosen weekday(s).',
    },
};

const RECURRENCE_ANCHOR_OPTIONS = [
    { value: 'floating', label: 'Floating', 'data-testid': 'recurrenceAnchorFloating' },
    { value: 'fixed', label: 'Fixed day', 'data-testid': 'recurrenceAnchorFixed' },
] as const;

interface RecurrenceAnchorToggleProps {
    mode: 'monthly' | 'weekly';
    state: FreqState;
    onUpdate: (patch: Partial<FreqState>) => void;
    disabled: boolean;
}

function RecurrenceAnchorToggle({ mode, state, onUpdate, disabled }: RecurrenceAnchorToggleProps) {
    return (
        <div className={styles.anchorToggle}>
            <ToggleGroup
                aria-label="Recurrence anchor"
                size="sm"
                disabled={disabled}
                value={state.recurrenceAnchor}
                onValueChange={(next) => onUpdate({ recurrenceAnchor: next })}
                options={RECURRENCE_ANCHOR_OPTIONS}
            />
            <Text variant="caption" tone="secondary" className={styles.preview}>
                {RECURRENCE_ANCHOR_CAPTIONS[mode][state.recurrenceAnchor]}
            </Text>
        </div>
    );
}

interface IntervalFieldProps {
    /** The words read on either side of the number: "Every [n] days". */
    before: string;
    after: string;
    /** The number field's accessible name — the words around it are not associated with it. */
    label: string;
    value: number;
    min: number;
    max?: number | undefined;
    onValueChange: (value: number) => void;
}

/** "Every [n] days": a narrow number field read in line with the words around it. */
function IntervalField({ before, after, label, value, min, max, onValueChange }: IntervalFieldProps) {
    const clamp = (raw: number) => Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, raw || min));
    return (
        <div className={styles.inlineRow}>
            <Text as="span" variant="bodySm">
                {before}
            </Text>
            <TextField
                type="number"
                size="sm"
                className={styles.narrowInput}
                value={value}
                onChange={(e) => onValueChange(clamp(parseInt(e.target.value, 10)))}
                inputProps={{ min, ...(max !== undefined ? { max } : {}), 'aria-label': label }}
            />
            <Text as="span" variant="bodySm">
                {after}
            </Text>
        </div>
    );
}

function SubFields({ mode, state, onUpdate, onToggleDay, disabled }: SubFieldsProps) {
    if (mode === 'yearly') {
        return null;
    }

    return (
        <div className={styles.subFields}>
            {mode === 'daily' && (
                <IntervalField
                    before="Every"
                    after="days"
                    label="Interval in days"
                    value={state.intervalDays}
                    min={1}
                    onValueChange={(intervalDays) => onUpdate({ intervalDays })}
                />
            )}
            {mode === 'weekly' && (
                <>
                    <RecurrenceAnchorToggle mode="weekly" state={state} onUpdate={onUpdate} disabled={disabled} />
                    {state.recurrenceAnchor === 'fixed' && (
                        <div className={styles.dayChips}>
                            {DAYS.map(({ key, label }) => (
                                <Chip key={key} label={label} selected={state.selectedDays.includes(key)} onClick={() => onToggleDay(key)} />
                            ))}
                        </div>
                    )}
                    <IntervalField
                        before="Every"
                        after="week(s)"
                        label="Interval in weeks"
                        value={state.intervalWeeks}
                        min={1}
                        onValueChange={(intervalWeeks) => onUpdate({ intervalWeeks })}
                    />
                </>
            )}
            {mode === 'monthly' && (
                <>
                    <RecurrenceAnchorToggle mode="monthly" state={state} onUpdate={onUpdate} disabled={disabled} />
                    {state.recurrenceAnchor === 'fixed' && (
                        <IntervalField
                            before="Day"
                            after="of the month"
                            label="Day of the month"
                            value={state.dayOfMonth}
                            min={1}
                            max={31}
                            onValueChange={(dayOfMonth) => onUpdate({ dayOfMonth })}
                        />
                    )}
                    <IntervalField
                        before="Every"
                        after="month(s)"
                        label="Interval in months"
                        value={state.intervalMonths}
                        min={1}
                        onValueChange={(intervalMonths) => onUpdate({ intervalMonths })}
                    />
                </>
            )}
        </div>
    );
}
