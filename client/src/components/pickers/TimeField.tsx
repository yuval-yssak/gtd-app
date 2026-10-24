import { TextField } from '../../designSystem';
import { ClearFieldButton } from './ClearFieldButton';
import { useClearAndRefocus } from './useClearAndRefocus';

export interface TimeFieldProps {
    label: string;
    /** `HH:mm` or empty. */
    value: string;
    onChange: (next: string) => void;
    size?: 'sm' | 'md' | undefined;
    required?: boolean | undefined;
    disabled?: boolean | undefined;
    className?: string | undefined;
}

/**
 * Native `<input type="time">` plus a Clear button — the mobile time wheels, like the date ones,
 * have no way to empty the field once it holds a value. The desktop browsers' own time dropdown
 * is kept: unlike the date indicator it has no in-app replacement.
 */
export function TimeField({ label, value, onChange, size, required, disabled, className }: TimeFieldProps) {
    const { inputRef, onCleared } = useClearAndRefocus(onChange);
    const showClear = value !== '' && !disabled;
    return (
        <TextField
            label={label}
            type="time"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            inputRef={inputRef}
            size={size}
            required={required}
            disabled={disabled}
            className={className}
            endAdornment={showClear ? <ClearFieldButton fieldName={label} onClear={onCleared} testId="timeFieldClear" edge="end" /> : undefined}
        />
    );
}
