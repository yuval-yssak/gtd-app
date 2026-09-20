import ClearIcon from '@mui/icons-material/Clear';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { BriefState } from '../../lib/briefSource';
import { BRIEF_LABEL, BRIEF_PLACEHOLDER, BRIEF_STALE_MARKER } from './briefSectionLogic';
import styles from './ItemEditorBody.module.css';

export interface BriefSectionProps {
    value: string;
    state: BriefState;
    onChange: (next: string) => void;
    /**
     * Persist `value` (blur / Enter / clear). The value travels with the call because a clear
     * fires `onChange('')` and commits in the same tick — before React has re-rendered the host's
     * state, so the host cannot read the field from its own refs yet. The host decides set vs
     * clear vs no-op.
     */
    onCommit: (value: string) => void;
    /**
     * `field` — the always-editable single-line input (the editor's default).
     * `line` — review presentation: the brief reads as a plain line under the title; clicking it
     * (or pressing Enter/Space on it) opens the field in place, and committing returns to the line.
     */
    variant?: 'field' | 'line';
}

/** Single-line brief under the title. Saves on blur/Enter through the host's `onCommit`. */
export function BriefSection({ value, state, onChange, onCommit, variant = 'field' }: BriefSectionProps) {
    const [isLineEditing, setIsLineEditing] = useState(false);
    const isLine = variant === 'line' && !isLineEditing;
    const marker = state === 'pinnedStale' ? <StaleMarker /> : null;

    if (isLine) {
        return (
            <Box>
                <BriefLine text={value} onActivate={() => setIsLineEditing(true)} />
                {marker}
            </Box>
        );
    }
    const commit = (committedValue: string) => {
        onCommit(committedValue);
        setIsLineEditing(false);
    };
    return (
        <Box>
            <TextField
                label={BRIEF_LABEL}
                placeholder={BRIEF_PLACEHOLDER}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onBlur={() => commit(value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        commit(value);
                    }
                }}
                fullWidth
                size="small"
                // Only the line→field transition auto-focuses: a freshly opened editor must not
                // yank focus to the brief (same rule the page-mode title/notes follow).
                autoFocus={isLineEditing}
                slotProps={{
                    input: {
                        endAdornment: value ? (
                            <BriefClearAdornment
                                onClear={() => {
                                    onChange('');
                                    commit('');
                                }}
                            />
                        ) : undefined,
                    },
                }}
                data-testid="briefField"
            />
            {marker}
        </Box>
    );
}

function BriefClearAdornment({ onClear }: { onClear: () => void }) {
    return (
        <InputAdornment position="end">
            <IconButton
                size="small"
                aria-label="Clear brief"
                // mousedown, not click: a click would blur the field first and commit the
                // still-populated value before the clear lands.
                onMouseDown={(e) => e.preventDefault()}
                onClick={onClear}
                data-testid="briefClearButton"
            >
                <ClearIcon fontSize="small" />
            </IconButton>
        </InputAdornment>
    );
}

function BriefLine({ text, onActivate }: { text: string; onActivate: () => void }) {
    return (
        <Typography
            variant="body1"
            className={styles.briefLine}
            // A focusable, keyboard-activatable line — its content is plain text (no links), so
            // exposing it as a button hides nothing from assistive tech.
            role="button"
            tabIndex={0}
            aria-label="Edit brief"
            onClick={onActivate}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onActivate();
                }
            }}
            data-testid="briefLine"
        >
            {text}
        </Typography>
    );
}

function StaleMarker() {
    return (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }} data-testid="briefStaleMarker">
            {BRIEF_STALE_MARKER}
        </Typography>
    );
}
