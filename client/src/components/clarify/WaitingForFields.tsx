import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { Link } from '@tanstack/react-router';
import type { StoredPerson } from '../../types/MyDB';
import { TicklerDateFields } from './TicklerDateFields';
import type { WaitingForFormState } from './types';
import styles from './WaitingForFields.module.css';

interface Props {
    value: WaitingForFormState;
    onChange: (patch: Partial<WaitingForFormState>) => void;
    people: StoredPerson[];
}

export function WaitingForFields({ value, onChange, people }: Props) {
    return (
        <Stack
            sx={{
                gap: 2,
            }}
        >
            {/* The person is optional — a waitingFor item can be blocked on something other than a
                named contact (e.g. "waiting for a part to arrive"). The "— No one —" entry clears it. */}
            <TextField
                select
                label="Waiting for (optional)"
                value={value.waitingForPersonId}
                onChange={(e) => onChange({ waitingForPersonId: e.target.value })}
                size="small"
                className={styles.waitingForSelect}
            >
                <MenuItem value="">— No one —</MenuItem>
                {people.map((p) => (
                    <MenuItem key={p._id} value={p._id}>
                        {p.name}
                    </MenuItem>
                ))}
            </TextField>
            {people.length === 0 && (
                <Typography
                    variant="body2"
                    sx={{
                        color: 'text.secondary',
                    }}
                >
                    No people yet — add contacts in the{' '}
                    <Link to="/people" className={styles.peopleLink}>
                        People
                    </Link>{' '}
                    section to name who you're waiting on.
                </Typography>
            )}
            <TicklerDateFields value={value} onChange={onChange} />
        </Stack>
    );
}
