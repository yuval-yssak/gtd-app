import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import { useAppData } from '../contexts/AppDataProvider';
import { getAccountColor } from '../lib/accountColors';
import styles from './AccountPicker.module.css';

interface AccountPickerProps {
    /** Currently-selected owner user id. Defaults to the entity's `userId` at the call site. */
    value: string;
    onChange: (userId: string) => void;
    /** Disabled while save is in flight, or when the entity can't be reassigned (routine-generated items). */
    disabled?: boolean;
    /** Surfaced as an inline error under the picker — e.g. "select a target calendar before saving". */
    error?: string;
}

/**
 * Picker visible only when the device hosts 2+ logged-in accounts. The selected account becomes
 * the new owner on save; the actual cross-user move happens server-side via `/sync/reassign`.
 * Hidden on single-account devices because there's nothing to choose.
 */
export function AccountPicker({ value, onChange, disabled, error }: AccountPickerProps) {
    const { loggedInAccounts } = useAppData();
    if (loggedInAccounts.length <= 1) {
        return null;
    }
    return (
        <FormControl size="small" fullWidth error={Boolean(error)}>
            <InputLabel>Account</InputLabel>
            <Select label="Account" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} data-testid="accountPicker">
                {loggedInAccounts.map((acct) => (
                    <MenuItem key={acct.id} value={acct.id}>
                        <span className={styles.colorDot} style={{ backgroundColor: getAccountColor(acct.id, loggedInAccounts) }} />
                        {acct.email}
                    </MenuItem>
                ))}
            </Select>
            {error && <div className={styles.error}>{error}</div>}
        </FormControl>
    );
}
