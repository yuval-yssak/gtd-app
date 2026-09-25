import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';

/** The two deferral dates shared by waitingFor and somedayMaybe forms. */
export interface TicklerDates {
    expectedBy: string;
    ignoreBefore: string;
}

interface Props {
    value: TicklerDates;
    onChange: (patch: Partial<TicklerDates>) => void;
}

/**
 * `Expected by` (deadline) + `Ignore before` (tickler) date inputs, shared by the waitingFor and
 * somedayMaybe forms. Both statuses participate in the tickler (TICKLER_STATUSES), so both expose it.
 */
export function TicklerDateFields({ value, onChange }: Props) {
    return (
        <Stack
            direction={{ xs: 'column', sm: 'row' }}
            sx={{
                gap: 2,
            }}
        >
            <TextField
                label="Expected by"
                type="date"
                value={value.expectedBy}
                onChange={(e) => onChange({ expectedBy: e.target.value })}
                size="small"
                slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
                label="Ignore before"
                type="date"
                value={value.ignoreBefore}
                onChange={(e) => onChange({ ignoreBefore: e.target.value })}
                size="small"
                slotProps={{ inputLabel: { shrink: true } }}
            />
        </Stack>
    );
}
