import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import type { SxProps, Theme } from '@mui/material/styles';
import TextField from '@mui/material/TextField';
import { type MouseEvent, useState } from 'react';
import { ClearFieldButton } from './ClearFieldButton';
import styles from './DateField.module.css';
import { DatePickerPopover } from './DatePickerPopover';
import { useClearAndRefocus } from './useClearAndRefocus';

/** Every field needs a name: either the floating label, or an accessible name when the caller
 *  renders its own caption (NextActionFields' "Tickler — hide until"). */
type DateFieldNaming = { label: string; accessibleName?: never } | { label?: never; accessibleName: string };

export type DateFieldProps = DateFieldNaming & {
    /** `YYYY-MM-DD` or empty. */
    value: string;
    onChange: (next: string) => void;
    size?: 'small' | 'medium';
    required?: boolean;
    disabled?: boolean;
    helperText?: string;
    className?: string;
    sx?: SxProps<Theme>;
    /** `data-testid` for the native input. */
    inputTestId?: string;
};

function fieldNameOf(naming: DateFieldNaming): string {
    return naming.label === undefined ? naming.accessibleName : naming.label;
}

/**
 * The app's one date input. Wraps the native `<input type="date">` — keyboard entry and the
 * mobile wheel pickers stay native — and adds what the native control lacks:
 *   - a Clear button, because iOS has no way to empty a date input once it holds a value;
 *   - a calendar button opening DatePickerPopover (quick picks + month grid), because typing
 *     segment-by-segment on a laptop is slow and desktop Safari has no picker at all.
 */
export function DateField({ value, onChange, size = 'small', required, disabled, helperText, className, sx, inputTestId, ...naming }: DateFieldProps) {
    const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null);
    const { inputRef, onCleared } = useClearAndRefocus(onChange);
    const fieldName = fieldNameOf(naming);

    function onDatePicked(dateIso: string) {
        onChange(dateIso);
        setPickerAnchor(null);
    }

    return (
        <>
            <TextField
                label={naming.label}
                type="date"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                inputRef={inputRef}
                size={size}
                required={required}
                disabled={disabled}
                helperText={helperText}
                className={className}
                sx={sx}
                slotProps={{
                    inputLabel: { shrink: true },
                    htmlInput: {
                        className: styles.nativeInput,
                        ...(naming.label === undefined ? { 'aria-label': naming.accessibleName } : {}),
                        ...(inputTestId ? { 'data-testid': inputTestId } : {}),
                    },
                    input: {
                        endAdornment: (
                            <DateFieldAdornment
                                fieldName={fieldName}
                                hasValue={value !== ''}
                                disabled={disabled ?? false}
                                onClear={onCleared}
                                onOpenPicker={setPickerAnchor}
                            />
                        ),
                    },
                }}
            />
            <DatePickerPopover anchorEl={pickerAnchor} value={value} onPick={onDatePicked} onClose={() => setPickerAnchor(null)} />
        </>
    );
}

interface AdornmentProps {
    fieldName: string;
    hasValue: boolean;
    disabled: boolean;
    onClear: (event: MouseEvent<HTMLButtonElement>) => void;
    onOpenPicker: (anchor: HTMLElement) => void;
}

/** Clear (only while there is a value) + Pick. Pick is named via `title` for the reason on ClearFieldButton. */
function DateFieldAdornment({ fieldName, hasValue, disabled, onClear, onOpenPicker }: AdornmentProps) {
    return (
        <InputAdornment position="end">
            {hasValue && !disabled && <ClearFieldButton fieldName={fieldName} onClear={onClear} testId="dateFieldClear" />}
            <IconButton
                title={`Pick ${fieldName}`}
                size="small"
                edge="end"
                disabled={disabled}
                onClick={(e) => onOpenPicker(e.currentTarget)}
                data-testid="dateFieldPick"
            >
                <CalendarTodayIcon fontSize="small" />
            </IconButton>
        </InputAdornment>
    );
}
