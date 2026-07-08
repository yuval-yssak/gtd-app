import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import { useAutoFocus } from '../hooks/useAutoFocus';
import styles from './ListSearch.module.css';

interface ListSearchButtonProps {
    onToggle: () => void;
    testId: string;
}

/** Header toggle for the in-page search field on virtualized list pages. */
export function ListSearchButton({ onToggle, testId }: ListSearchButtonProps) {
    return (
        <Tooltip title="Search this list">
            <IconButton size="small" aria-label="Search this list" onClick={onToggle} data-testid={testId}>
                <SearchIcon fontSize="small" />
            </IconButton>
        </Tooltip>
    );
}

interface ListSearchFieldProps {
    value: string;
    onValueChange: (value: string) => void;
    /** Fired by the close adornment and the Escape key — collapses the field and clears the query. */
    onClose: () => void;
    placeholder: string;
    testId: string;
}

/**
 * In-page search field for virtualized list pages: offscreen rows are not mounted, so the
 * browser's find-in-page can't see them — this filter is the replacement.
 */
export function ListSearchField({ value, onValueChange, onClose, placeholder, testId }: ListSearchFieldProps) {
    const inputRef = useAutoFocus();
    return (
        <TextField
            size="small"
            fullWidth
            placeholder={placeholder}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            onKeyDown={(e) => {
                if (e.key === 'Escape') onClose();
            }}
            className={styles.searchField}
            slotProps={{
                htmlInput: { ref: inputRef, 'data-testid': testId },
                input: {
                    endAdornment: (
                        <InputAdornment position="end">
                            <Tooltip title="Close search">
                                <IconButton size="small" aria-label="Close search" edge="end" onClick={onClose}>
                                    <CloseIcon fontSize="small" />
                                </IconButton>
                            </Tooltip>
                        </InputAdornment>
                    ),
                },
            }}
        />
    );
}
