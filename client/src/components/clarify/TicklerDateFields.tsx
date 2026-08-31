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
    /**
     * Whether to render the `Ignore before` tickler input. Defaults to true (somedayMaybe).
     * WaitingFor passes false — a waiting item has no reason to be hidden until a future date, so
     * only `Expected by` is meaningful there.
     */
    showIgnoreBefore?: boolean;
}

/**
 * `Expected by` (deadline) + optional `Ignore before` (tickler) date inputs. Extracted so waitingFor
 * and somedayMaybe share the layout; waitingFor opts out of the tickler field via showIgnoreBefore.
 * NOTE: hiding the field is UI-only — `ignoreBefore` remains valid on waitingFor items via the
 * public API/MCP (the server's status→field matrix allows it), and /waiting-for + /tickler both
 * honor it. Don't treat the waitingFor tickler filtering as unreachable code.
 */
export function TicklerDateFields({ value, onChange, showIgnoreBefore = true }: Props) {
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
            {showIgnoreBefore && (
                <TextField
                    label="Ignore before"
                    type="date"
                    value={value.ignoreBefore}
                    onChange={(e) => onChange({ ignoreBefore: e.target.value })}
                    size="small"
                    slotProps={{ inputLabel: { shrink: true } }}
                />
            )}
        </Stack>
    );
}
