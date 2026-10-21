import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CheckIcon from '@mui/icons-material/Check';
import ClearIcon from '@mui/icons-material/Clear';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import Alert from '@mui/material/Alert';
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
import { type KeyboardEvent, type Ref, useEffect, useId, useRef, useState } from 'react';
import type { BriefState } from '../../lib/briefSource';
import { collapseToSingleLine } from '../../lib/singleLineText';
import type { BriefOrigin } from '../../types/MyDB';
import {
    BRIEF_LABEL,
    BRIEF_PINNED_NOTICE,
    BRIEF_PLACEHOLDER,
    BRIEF_STALE_MARKER,
    describeDeclinedBrief,
    describeEmptyBrief,
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
     * Both variants rest read-only with a pencil; they differ only in presentation.
     * `field` — the editor's default: a "Brief" section label above the brief.
     * `line` — review presentation: no label, so the brief reads as a plain line under the title.
     */
    variant?: 'field' | 'line';
    /**
     * Whether the item is open (briefs are generated only for open items). A done/trashed item's
     * empty brief must not promise "one is written automatically" — no sweep will ever write it.
     */
    isBriefable?: boolean;
}

/**
 * The brief under the title. Read-only by default — like the page-mode notes, the pencil is the
 * only way into the field, because a typed brief is PINNED (the sweep stops refreshing it) and
 * that should be a deliberate act, never a stray click. While editing, a visible notice says so.
 * Saves on blur/Enter/Escape/Done/Clear through the host's `onCommit`, then returns to the read view.
 */
export function BriefSection({ value, state, origin, onChange, onCommit, generation, variant = 'field', isBriefable = true }: BriefSectionProps) {
    const [isEditing, setIsEditing] = useState(false);
    const pencilFocus = useFocusOnViewReturn(isEditing);
    const noticeId = useId();
    // "Regenerate" whenever the user can SEE a brief — a stale model row still fills the field
    // even though its derived state is `none`. A `declined` row shows no brief text, so the
    // button stays "Generate" there: pressing it after editing the notes is the intended retry.
    const isRegenerate = state === 'fresh' || state === 'pinnedStale' || value.trim().length > 0;
    const commitOnLeave = (committedValue: string) => {
        onCommit(committedValue);
        setIsEditing(false);
    };
    const commitAndExit = (committedValue: string) => {
        pencilFocus.requestFocus();
        commitOnLeave(committedValue);
    };

    return (
        <Box data-testid="briefSection">
            {variant === 'field' && (
                <Typography variant="caption" className={styles.sectionLabel} sx={{ color: 'text.secondary', fontWeight: 600, mb: 0 }}>
                    {BRIEF_LABEL}
                </Typography>
            )}
            {/* Fixed child order — content, pencil, generate — so the generate button stays the SAME
                mounted element across the edit→view flip its own click's blur triggers. */}
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
                {isEditing ? (
                    <BriefEditor value={value} noticeId={noticeId} onChange={onChange} onLeave={commitOnLeave} onExit={commitAndExit} />
                ) : (
                    <BriefText text={value} emptyHint={describeEmptyBrief(state, isBriefable)} isLine={variant === 'line'} />
                )}
                {isEditing ? null : <BriefEditButton ref={pencilFocus.ref} onEdit={() => setIsEditing(true)} />}
                <GenerateBriefButton generation={generation} isRegenerate={isRegenerate} fieldValue={value} />
            </Stack>
            {isEditing && (
                // role="status", not MUI's default "alert": the notice must be read WITH the newly
                // focused field (aria-describedby), not interrupt its announcement on every open.
                <Alert id={noticeId} role="status" severity="info" variant="outlined" sx={{ mt: 1, py: 0 }} data-testid="briefPinnedNotice">
                    {BRIEF_PINNED_NOTICE}
                </Alert>
            )}
            <BriefStateNote state={state} origin={origin} fieldValue={value} />
            <BriefGenerationFeedback generation={generation} />
        </Box>
    );
}

/**
 * Moves focus to the pencil when the read view returns after an explicit exit (Done/Enter/Escape/
 * Clear): those unmount the focused control, which would otherwise drop focus to the page body.
 * A blur exit leaves focus where the user put it, so it never requests this.
 */
function useFocusOnViewReturn(isEditing: boolean) {
    const ref = useRef<HTMLButtonElement | null>(null);
    const isFocusRequested = useRef(false);
    useEffect(() => {
        if (!isEditing && isFocusRequested.current) {
            isFocusRequested.current = false;
            ref.current?.focus();
        }
    }, [isEditing]);
    return { ref, requestFocus: () => (isFocusRequested.current = true) };
}

interface BriefEditorProps {
    value: string;
    noticeId: string;
    onChange: (next: string) => void;
    /** Focus left the field and its own buttons — commit and let focus stay where it went. */
    onLeave: (value: string) => void;
    /** Done / Enter / Escape / Clear — commit and hand focus back to the pencil. */
    onExit: (value: string) => void;
}

/**
 * The open field plus its Done button. The blur commit listens on this WRAPPER, not the textarea:
 * Tab from the textarea to Clear or Done is focus staying inside the editor, and committing there
 * would unmount the very button receiving focus (dropping keyboard users onto the page body).
 */
function BriefEditor({ value, noticeId, onChange, onLeave, onExit }: BriefEditorProps) {
    return (
        <Box
            sx={{ display: 'flex', flexGrow: 1, alignItems: 'flex-start', gap: 0.5 }}
            onBlur={(e) => {
                if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) {
                    return;
                }
                onLeave(value);
            }}
        >
            <TextField
                placeholder={BRIEF_PLACEHOLDER}
                value={value}
                // The field wraps (multiline), so a pasted newline would otherwise survive into a
                // brief that renders as one line everywhere. Typed Enter commits (below) instead.
                onChange={(e) => onChange(collapseToSingleLine(e.target.value))}
                // Wraps instead of scrolling horizontally so a full brief is readable beside the
                // title without scrolling. Enter still commits (handled above), so no newline lands.
                multiline
                fullWidth
                size="small"
                // Mounted only by the pencil, so focusing it never yanks focus on editor open.
                autoFocus
                slotProps={{
                    htmlInput: {
                        'aria-label': BRIEF_LABEL,
                        'aria-describedby': noticeId,
                        // On the textarea itself, not the TextField root: the Clear button lives in
                        // the root's end adornment, and a root handler would swallow Enter on it
                        // (preventDefault cancels the button's click) and commit the old text.
                        onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
                            // Mid-composition Enter/Escape belong to the IME (confirm/cancel the candidate).
                            if (e.nativeEvent.isComposing || (e.key !== 'Enter' && e.key !== 'Escape')) {
                                return;
                            }
                            // Escape steps out of the field only: claim it so the page-level ESC-to-leave
                            // and a dialog's ESC-to-close don't also fire.
                            e.preventDefault();
                            e.stopPropagation();
                            onExit(value);
                        },
                    },
                    input: {
                        // A multiline field grows downward; the clear button belongs on the first line.
                        sx: { alignItems: 'flex-start' },
                        endAdornment: value ? (
                            <InputAdornment position="end">
                                <BriefClearButton
                                    onClear={() => {
                                        onChange('');
                                        onExit('');
                                    }}
                                />
                            </InputAdornment>
                        ) : undefined,
                    },
                }}
                data-testid="briefField"
            />
            <BriefDoneButton onDone={() => onExit(value)} />
        </Box>
    );
}

/** Read view: the brief as plain text, or a muted hint about why there is none. */
function BriefText({ text, emptyHint, isLine }: { text: string; emptyHint: string; isLine: boolean }) {
    if (!text.trim()) {
        return (
            <Typography variant="body2" className={styles.briefText} sx={{ color: 'text.secondary' }} data-testid="briefEmpty">
                {emptyHint}
            </Typography>
        );
    }
    return (
        <Typography variant={isLine ? 'body1' : 'body2'} className={styles.briefText} data-testid="briefLine">
            {text}
        </Typography>
    );
}

function BriefEditButton({ ref, onEdit }: { ref: Ref<HTMLButtonElement>; onEdit: () => void }) {
    return (
        <IconButton ref={ref} size="small" aria-label="Edit brief" title="Edit brief" onClick={onEdit} data-testid="briefEditButton">
            <EditOutlinedIcon fontSize="small" />
        </IconButton>
    );
}

function BriefDoneButton({ onDone }: { onDone: () => void }) {
    return (
        <IconButton
            size="small"
            aria-label="Done editing brief"
            title="Done editing brief"
            // Keep focus in the field on press: otherwise its blur flips to the read view first
            // and the click would land on the pencil that replaced this button.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onDone}
            data-testid="briefDoneButton"
        >
            <CheckIcon fontSize="small" />
        </IconButton>
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
