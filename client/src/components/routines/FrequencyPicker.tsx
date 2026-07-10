import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import dayjs from 'dayjs';
import { useState } from 'react';
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
            <Typography variant="caption" className={styles.preview}>
                Next due: {dayjs(next).format('ddd, MMM D, YYYY')}
            </Typography>
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
        <fieldset disabled={disabled} style={{ border: 'none', padding: 0, margin: 0, opacity: disabled ? 0.5 : 1 }}>
            <RadioGroup value={state.mode} onChange={(e) => update({ mode: e.target.value as FreqMode })} className={styles.modeGroup}>
                {(Object.keys(MODE_LABELS) as FreqMode[]).map((mode) => (
                    <div key={mode}>
                        <FormControlLabel value={mode} control={<Radio size="small" />} label={<Typography variant="body2">{MODE_LABELS[mode]}</Typography>} />
                        {state.mode === mode && <SubFields mode={mode} state={state} onUpdate={update} onToggleDay={toggleDay} />}
                    </div>
                ))}
            </RadioGroup>

            <NextDuePreview rrule={currentRrule} />
        </fieldset>
    );
}

interface SubFieldsProps {
    mode: FreqMode;
    state: FreqState;
    onUpdate: (patch: Partial<FreqState>) => void;
    onToggleDay: (key: string) => void;
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

function RecurrenceAnchorToggle({ mode, state, onUpdate }: { mode: 'monthly' | 'weekly'; state: FreqState; onUpdate: (patch: Partial<FreqState>) => void }) {
    return (
        <div className={styles.subFields}>
            <ToggleButtonGroup
                value={state.recurrenceAnchor}
                exclusive
                size="small"
                onChange={(_, next: RecurrenceAnchor | null) => next && onUpdate({ recurrenceAnchor: next })}
            >
                <ToggleButton value="floating" data-testid="recurrenceAnchorFloating">
                    Floating
                </ToggleButton>
                <ToggleButton value="fixed" data-testid="recurrenceAnchorFixed">
                    Fixed day
                </ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" className={styles.preview}>
                {RECURRENCE_ANCHOR_CAPTIONS[mode][state.recurrenceAnchor]}
            </Typography>
        </div>
    );
}

function SubFields({ mode, state, onUpdate, onToggleDay }: SubFieldsProps) {
    if (mode === 'yearly') return null;

    return (
        <div className={styles.subFields}>
            {mode === 'daily' && (
                <div className={styles.inlineRow}>
                    <Typography variant="body2">Every</Typography>
                    <TextField
                        type="number"
                        size="small"
                        className={styles.narrowInput}
                        value={state.intervalDays}
                        onChange={(e) => onUpdate({ intervalDays: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                        slotProps={{ htmlInput: { min: 1 } }}
                    />
                    <Typography variant="body2">days</Typography>
                </div>
            )}
            {mode === 'weekly' && (
                <>
                    <RecurrenceAnchorToggle mode="weekly" state={state} onUpdate={onUpdate} />
                    {state.recurrenceAnchor === 'fixed' && (
                        <Stack
                            direction="row"
                            sx={{
                                flexWrap: 'wrap',
                                gap: 0.5,
                            }}
                        >
                            {DAYS.map(({ key, label }) => (
                                <Chip
                                    key={key}
                                    label={label}
                                    size="small"
                                    variant={state.selectedDays.includes(key) ? 'filled' : 'outlined'}
                                    color={state.selectedDays.includes(key) ? 'primary' : 'default'}
                                    onClick={() => onToggleDay(key)}
                                />
                            ))}
                        </Stack>
                    )}
                    <div className={styles.inlineRow}>
                        <Typography variant="body2">Every</Typography>
                        <TextField
                            type="number"
                            size="small"
                            className={styles.narrowInput}
                            value={state.intervalWeeks}
                            onChange={(e) => onUpdate({ intervalWeeks: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                            slotProps={{ htmlInput: { min: 1 } }}
                        />
                        <Typography variant="body2">week(s)</Typography>
                    </div>
                </>
            )}
            {mode === 'monthly' && (
                <>
                    <RecurrenceAnchorToggle mode="monthly" state={state} onUpdate={onUpdate} />
                    {state.recurrenceAnchor === 'fixed' && (
                        <div className={styles.inlineRow}>
                            <Typography variant="body2">Day</Typography>
                            <TextField
                                type="number"
                                size="small"
                                className={styles.narrowInput}
                                value={state.dayOfMonth}
                                onChange={(e) => onUpdate({ dayOfMonth: Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1)) })}
                                slotProps={{ htmlInput: { min: 1, max: 31 } }}
                            />
                            <Typography variant="body2">of the month</Typography>
                        </div>
                    )}
                    <div className={styles.inlineRow}>
                        <Typography variant="body2">Every</Typography>
                        <TextField
                            type="number"
                            size="small"
                            className={styles.narrowInput}
                            value={state.intervalMonths}
                            onChange={(e) => onUpdate({ intervalMonths: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                            slotProps={{ htmlInput: { min: 1 } }}
                        />
                        <Typography variant="body2">month(s)</Typography>
                    </div>
                </>
            )}
        </div>
    );
}
