import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { StoredPerson } from '../../types/MyDB';
import type { WaitingForFormState } from './types';
import styles from './WaitingForFields.module.css';

interface Props {
    value: WaitingForFormState;
    onChange: (patch: Partial<WaitingForFormState>) => void;
    people: StoredPerson[];
}

export function WaitingForFields({ value, onChange, people }: Props) {
    if (people.length === 0) {
        return (
            <Typography
                variant="body2"
                sx={{
                    color: 'text.secondary',
                }}
            >
                No people yet — add contacts in the People section first.
            </Typography>
        );
    }

    return (
        <Stack
            sx={{
                gap: 2,
            }}
        >
            <TextField
                select
                label="Waiting for"
                value={value.waitingForPersonId}
                onChange={(e) => onChange({ waitingForPersonId: e.target.value })}
                size="small"
                required
                className={styles.waitingForSelect}
            >
                {people.map((p) => (
                    <MenuItem key={p._id} value={p._id}>
                        {p.name}
                    </MenuItem>
                ))}
            </TextField>
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
        </Stack>
    );
}
