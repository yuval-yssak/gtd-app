import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import type { CalendarOption } from '../../hooks/useCalendarOptions';
import type { CalendarFormState } from './types';

interface Props {
    value: CalendarFormState;
    onChange: (patch: Partial<CalendarFormState>) => void;
    /** Available calendars for the picker. Omit or pass empty to hide the picker. */
    calendarOptions?: CalendarOption[];
}

export function CalendarFields({ value, onChange, calendarOptions }: Props) {
    const showPicker = calendarOptions !== undefined && calendarOptions.length > 1;

    return (
        <Stack gap={2}>
            <TextField
                label="Date"
                type="date"
                value={value.date}
                onChange={(e) => onChange({ date: e.target.value })}
                size="small"
                required
                slotProps={{ inputLabel: { shrink: true } }}
            />
            <Stack direction="row" gap={2}>
                <TextField
                    label="Start time"
                    type="time"
                    value={value.startTime}
                    onChange={(e) => onChange({ startTime: e.target.value })}
                    size="small"
                    slotProps={{ inputLabel: { shrink: true } }}
                />
                <TextField
                    label="End time"
                    type="time"
                    value={value.endTime}
                    onChange={(e) => onChange({ endTime: e.target.value })}
                    size="small"
                    slotProps={{ inputLabel: { shrink: true } }}
                />
            </Stack>
            {/* Only show picker when user has 2+ calendars — with 0-1 there's nothing to choose. */}
            {showPicker && (
                <FormControl size="small">
                    <InputLabel>Calendar</InputLabel>
                    <Select label="Calendar" value={value.calendarSyncConfigId} onChange={(e) => onChange({ calendarSyncConfigId: e.target.value })}>
                        {/* Empty value = server picks the default calendar */}
                        <MenuItem value="">Default</MenuItem>
                        {calendarOptions.map((opt) => (
                            <MenuItem key={opt.configId} value={opt.configId}>
                                {opt.displayName}
                            </MenuItem>
                        ))}
                    </Select>
                </FormControl>
            )}
        </Stack>
    );
}
