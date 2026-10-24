import { Search, X } from 'lucide-react';
import { IconButton, TextField, Tooltip } from '../designSystem';
import { useAutoFocus } from '../hooks/useAutoFocus';
import { LIST_SEARCH_INPUT_ATTR, LIST_SEARCH_TOGGLE_ATTR } from '../lib/keyboardRegionDom';
import styles from './ListSearch.module.css';

interface ListSearchButtonProps {
    onToggle: () => void;
    testId: string;
}

/** Header toggle for the in-page search field on virtualized list pages. */
export function ListSearchButton({ onToggle, testId }: ListSearchButtonProps) {
    return (
        <Tooltip title="Search this list (/)">
            <IconButton
                size="sm"
                aria-label="Search this list"
                aria-keyshortcuts="/"
                onClick={onToggle}
                data-testid={testId}
                {...{ [LIST_SEARCH_TOGGLE_ATTR]: '' }}
            >
                <Search />
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
            fullWidth
            placeholder={placeholder}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            onKeyDown={(e) => {
                if (e.key === 'Escape') onClose();
            }}
            className={styles.searchField}
            startAdornment={<Search size={18} aria-hidden="true" />}
            inputRef={inputRef}
            inputProps={{ 'aria-label': placeholder, 'data-testid': testId, [LIST_SEARCH_INPUT_ATTR]: '' }}
            endAdornment={
                <Tooltip title="Close search (Esc)">
                    <IconButton size="sm" aria-label="Close search" aria-keyshortcuts="Escape" edge="end" onClick={onClose}>
                        <X />
                    </IconButton>
                </Tooltip>
            }
        />
    );
}
