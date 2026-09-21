import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ClearIcon from '@mui/icons-material/Clear';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { BriefState } from '../../lib/briefSource';
import type { BriefOrigin } from '../../types/MyDB';
import {
    BRIEF_LABEL,
    BRIEF_PLACEHOLDER,
    BRIEF_STALE_MARKER,
    describeDeclinedBrief,
    describeGenerateButton,
    isDeclinedNoteVisible,
    REPLACE_BRIEF_PROMPT,
} from './briefSectionLogic';
import styles from './ItemEditorBody.module.css';
import type { BriefGeneration } from './useBriefGeneration';

export interface BriefSectionProps {
    value: string;
    state: BriefState;
    /**
     * The stored row's origin, when there is a row. Only read for `state === 'declined'`, where it
     * decides whether the caption says the model found nothing to condense or that the notes were
     * too short to ask in the first place.
     */
    origin?: BriefOrigin | undefined;
    onChange: (next: string) => void;
    /**
     * Persist `value` (blur / Enter / clear). The value travels with the call because a clear
     * fires `onChange('')` and commits in the same tick — before React has re-rendered the host's
     * state, so the host cannot read the field from its own refs yet. The host decides set vs
     * clear vs no-op.
     */
    onCommit: (value: string) => void;
    /** The AI "Generate brief" button's state machine — see `useBriefGeneration`. */
    generation: BriefGeneration;
    /**
     * `field` — the always-editable single-line input (the editor's default).
     * `line` — review presentation: the brief reads as a plain line under the title; clicking it
     * (or pressing Enter/Space on it) opens the field in place, and committing returns to the line.
     */
    variant?: 'field' | 'line';
}

/** Single-line brief under the title. Saves on blur/Enter through the host's `onCommit`. */
export function BriefSection({ value, state, origin, onChange, onCommit, generation, variant = 'field' }: BriefSectionProps) {
    const [isLineEditing, setIsLineEditing] = useState(false);
    const isLine = variant === 'line' && !isLineEditing;
    // "Regenerate" whenever the user can SEE a brief — a stale model row still fills the field
    // even though its derived state is `none`. A `declined` row shows no brief text, so the
    // button stays "Generate" there: pressing it after editing the notes is the intended retry.
    const isRegenerate = state === 'fresh' || state === 'pinnedStale' || value.trim().length > 0;
    const stateNote = <BriefStateNote state={state} origin={origin} fieldValue={value} />;
    const generateButton = <GenerateBriefButton generation={generation} isRegenerate={isRegenerate} fieldValue={value} />;

    if (isLine) {
        return (
            <Box>
                <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    <BriefLine text={value} onActivate={() => setIsLineEditing(true)} />
                    {generateButton}
                </Stack>
                {stateNote}
                <BriefGenerationFeedback generation={generation} />
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
                        endAdornment: (
                            <InputAdornment position="end">
                                {value && (
                                    <BriefClearButton
                                        onClear={() => {
                                            onChange('');
                                            commit('');
                                        }}
                                    />
                                )}
                                {generateButton}
                            </InputAdornment>
                        ),
                    },
                }}
                data-testid="briefField"
            />
            {stateNote}
            <BriefGenerationFeedback generation={generation} />
        </Box>
    );
}

function BriefClearButton({ onClear }: { onClear: () => void }) {
    return (
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
    );
}

/**
 * The sparkle button. Unlike the clear button it lets the click BLUR the field on purpose: any
 * text typed there must commit (as a user brief) before the request goes out, so the server sees
 * the same pinned-or-not state the inline confirm gate decided on.
 *
 * That commit is a plain local put with no LWW check, so it must land BEFORE the generated row is
 * applied. The confirm gate is what serialises the two: a dirty field always routes through
 * `confirm` (a human-scale pause before the request), and a clean field commits nothing. Making
 * the confirm optional would let the commit clobber the freshly generated row.
 */
function GenerateBriefButton({ generation, isRegenerate, fieldValue }: { generation: BriefGeneration; isRegenerate: boolean; fieldValue: string }) {
    const { label, tooltip, isDisabled } = describeGenerateButton({ isRegenerate, isOnline: generation.isOnline, phase: generation.phase });
    return (
        <Tooltip title={tooltip}>
            {/* A disabled button fires no pointer events, so the tooltip needs a live wrapper to anchor to. */}
            <span>
                <IconButton
                    size="small"
                    aria-label={label}
                    disabled={isDisabled}
                    onClick={() => generation.requestGenerate(fieldValue)}
                    data-testid="briefGenerateButton"
                >
                    {generation.phase === 'loading' ? <CircularProgress size={18} /> : <AutoAwesomeIcon fontSize="small" />}
                </IconButton>
            </span>
        </Tooltip>
    );
}

/** The inline Replace/Keep confirm and the outcome snackbar — everything the generation says back. */
function BriefGenerationFeedback({ generation }: { generation: BriefGeneration }) {
    return (
        <>
            {generation.phase === 'confirm' && <ReplaceConfirm onReplace={generation.confirmReplace} onKeep={generation.keepBrief} />}
            <Snackbar
                open={generation.notice !== null}
                autoHideDuration={6000}
                // A click elsewhere on the page must not swallow the notice before it is read.
                onClose={(_event, reason) => {
                    if (reason !== 'clickaway') {
                        generation.dismissNotice();
                    }
                }}
                message={generation.notice}
                data-testid="briefGenerateNotice"
            />
        </>
    );
}

function ReplaceConfirm({ onReplace, onKeep }: { onReplace: () => void; onKeep: () => void }) {
    return (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.5 }} data-testid="briefReplaceConfirm">
            <Typography variant="body2">{REPLACE_BRIEF_PROMPT}</Typography>
            <Button size="small" variant="contained" onClick={onReplace} data-testid="briefReplaceButton">
                Replace
            </Button>
            <Button size="small" onClick={onKeep} data-testid="briefKeepButton">
                Keep
            </Button>
        </Stack>
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

/**
 * The at-most-one muted line under the brief that explains the row's state. `declined` is the
 * reason this exists: a text-less row would otherwise render as an ordinary empty field, leaving
 * the user unable to tell a deliberate "nothing to summarise" from a broken or pending feature.
 * Both states cost exactly one caption line, so a review card never grows taller than before.
 *
 * The declined caption tracks the LIVE field value (see `isDeclinedNoteVisible`), so it clears on
 * the first keystroke rather than lingering over text the user is already writing.
 *
 * Rendered by BOTH variants, but `declined` only ever reaches the field one: `isBriefFirst`
 * returns false for it, so the host never picks `variant="line"` for a declined row (a line
 * variant would show this caption under an empty brief line, which reads as a bug).
 */
function BriefStateNote({ state, origin, fieldValue }: { state: BriefState; origin: BriefOrigin | undefined; fieldValue: string }) {
    if (state === 'pinnedStale') {
        return <BriefCaption text={BRIEF_STALE_MARKER} testId="briefStaleMarker" />;
    }
    if (isDeclinedNoteVisible({ state, fieldValue })) {
        // `declined` implies a stored row, so `origin` is always supplied by the real host. Fall
        // back rather than render nothing: a missing prop must not silently restore the blank
        // field this caption exists to replace.
        return <BriefCaption text={describeDeclinedBrief(origin ?? 'model')} testId="briefDeclinedNote" />;
    }
    return null;
}

function BriefCaption({ text, testId }: { text: string; testId: string }) {
    return (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }} data-testid={testId}>
            {text}
        </Typography>
    );
}
