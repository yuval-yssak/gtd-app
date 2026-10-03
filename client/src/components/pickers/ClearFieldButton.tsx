import ClearIcon from '@mui/icons-material/Clear';
import IconButton from '@mui/material/IconButton';
import type { MouseEvent } from 'react';

interface Props {
    /** The field's visible label or accessible name — the button reads "Clear <fieldName>". */
    fieldName: string;
    onClear: (event: MouseEvent<HTMLButtonElement>) => void;
    testId: string;
    /** `edge="end"` when this is the last adornment, so it sits flush with the input's edge. */
    edge?: 'end' | false;
}

/**
 * The Clear adornment shared by DateField and TimeField.
 *
 * It is named with `title`, not `aria-label`, on purpose. The name contains the field label
 * ("Clear Expected by"), and Playwright's `getByLabel` matches `aria-label` on any element as a
 * substring — an `aria-label` here would make every `getByLabel('Expected by')` resolve to the
 * input plus this button. `title` yields the same accessible name (and a desktop tooltip) without
 * being a label. Don't wrap it in MUI Tooltip: that copies the title into `aria-label`.
 */
export function ClearFieldButton({ fieldName, onClear, testId, edge = false }: Props) {
    return (
        <IconButton title={`Clear ${fieldName}`} size="small" edge={edge} onClick={onClear} data-testid={testId}>
            <ClearIcon fontSize="small" />
        </IconButton>
    );
}
