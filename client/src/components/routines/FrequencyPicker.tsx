import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import dayjs from 'dayjs';
import { useState } from 'react';
import { computeNextOccurrence } from '../../lib/rruleUtils';
import styles from './FrequencyPicker.module.css';

type FreqMode = 'daily' | 'weekly' | 'monthly' | 'yearly';

interface FreqState {
    mode: FreqMode;
    intervalDays: number;
    selectedDays: string[]; // RFC 5545 BYDAY values: 'MO','TU','WE','TH','FR','SA','SU'
    intervalWeeks: number;
    dayOfMonth: number;
    intervalMonths: number;
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

// Simple string-based rrule parser — avoids dealing with rrule.js's complex byweekday union types.
function parseToFreqState(rruleStr: string): FreqState {
    const defaults: FreqState = { mode: 'daily', intervalDays: 1, selectedDays: ['MO'], intervalWeeks: 1, dayOfMonth: 1, intervalMonths: 1 };
    if (!rruleStr) return defaults;
    const parts = rruleStr.toUpperCase().split(';');
    const get = (key: string) => parts.find((p) => p.startsWith(`${key}=`))?.split('=')[1];
    const interval = parseInt(get('INTERVAL') ?? '1', 10);
    const freq = get('FREQ');
    if (freq === 'YEARLY') return { ...defaults, mode: 'yearly' };
    if (freq === 'MONTHLY') return { ...defaults, mode: 'monthly', dayOfMonth: parseInt(get('BYMONTHDAY') ?? '1', 10), intervalMonths: interval };
    if (freq === 'WEEKLY') {
        const days = (get('BYDAY') ?? 'MO').split(',').filter(Boolean);
        return { ...defaults, mode: 'weekly', selectedDays: days, intervalWeeks: interval };
    }
    return { ...defaults, mode: 'daily', intervalDays: interval };
}

function buildRrule(state: FreqState): string {
    switch (state.mode) {
        case 'yearly':
            return 'FREQ=YEARLY';
        case 'monthly': {
            const intervalSuffix = state.intervalMonths > 1 ? `;INTERVAL=${state.intervalMonths}` : '';
            return `FREQ=MONTHLY;BYMONTHDAY=${state.dayOfMonth}${intervalSuffix}`;
        }
        case 'weekly': {
            const byday = state.selectedDays.length > 0 ? state.selectedDays.join(',') : 'MO';
            const intervalSuffix = state.intervalWeeks > 1 ? `;INTERVAL=${state.intervalWeeks}` : '';
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
    onChange: (rrule: string) => void;
}

export function FrequencyPicker({ value, onChange }: Props) {
    const [state, setState] = useState<FreqState>(() => parseToFreqState(value));

    function update(patch: Partial<FreqState>) {
        const next = { ...state, ...patch };
        setState(next);
        onChange(buildRrule(next));
    }

    function toggleDay(key: string) {
        const days = state.selectedDays.includes(key) ? state.selectedDays.filter((d) => d !== key) : [...state.selectedDays, key];
        // Keep at least one day selected to produce a valid rrule
        update({ selectedDays: days.length > 0 ? days : [key] });
    }

    const currentRrule = buildRrule(state);

    return (
        <div className={styles.root}>
            <RadioGroup value={state.mode} onChange={(e) => update({ mode: e.target.value as FreqMode })} className={styles.modeGroup}>
                {(Object.keys(MODE_LABELS) as FreqMode[]).map((mode) => (
                    <div key={mode}>
                        <FormControlLabel value={mode} control={<Radio size="small" />} label={<Typography variant="body2">{MODE_LABELS[mode]}</Typography>} />
                        {state.mode === mode && <SubFields mode={mode} state={state} onUpdate={update} onToggleDay={toggleDay} />}
                    </div>
                ))}
            </RadioGroup>

            <NextDuePreview rrule={currentRrule} />
        </div>
    );
}

interface SubFieldsProps {
    mode: FreqMode;
    state: FreqState;
    onUpdate: (patch: Partial<FreqState>) => void;
    onToggleDay: (key: string) => void;
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
                    <Stack direction="row" flexWrap="wrap" gap={0.5}>
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
