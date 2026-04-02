import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import type { CalendarFormState } from './types';

interface Props {
    value: CalendarFormState;
    onChange: (patch: Partial<CalendarFormState>) => void;
}

export function CalendarFields({ value, onChange }: Props) {
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
        </Stack>
    );
}
