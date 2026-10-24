import { Check, Pencil, Sparkles, X } from 'lucide-react';
import { type KeyboardEvent, type Ref, useEffect, useId, useRef, useState } from 'react';
import { Button, Callout, IconButton, Spinner, Text, TextField, Toast, Tooltip } from '../../designSystem';
import type { BriefState } from '../../lib/briefSource';
import { collapseToSingleLine } from '../../lib/singleLineText';
import type { BriefOrigin } from '../../types/MyDB';
import {
    BRIEF_EDITOR_LABEL,
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
    variant?: 'field' | 'line' | undefined;
    /**
     * Whether the item is open (briefs are generated only for open items). A done/trashed item's
     * empty brief must not promise "one is written automatically" — no sweep will ever write it.
     */
    isBriefable?: boolean | undefined;
}

/**
 * The brief under the title. Read-only by default — like the notes, the pencil is the
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
        <div data-testid="briefSection">
            {variant === 'field' && (
                <Text as="span" variant="caption" tone="secondary" weight="semibold" className={styles.notesLabel}>
                    {BRIEF_LABEL}
                </Text>
            )}
            {/* Fixed child order — content, pencil, generate — so the generate button stays the SAME
                mounted element across the edit→view flip its own click's blur triggers. */}
            <div className={styles.briefRow}>
                {isEditing ? (
                    <BriefEditor value={value} noticeId={noticeId} onChange={onChange} onLeave={commitOnLeave} onExit={commitAndExit} />
                ) : (
                    <BriefReadView value={value} state={state} origin={origin} isBriefable={isBriefable} isLine={variant === 'line'} />
                )}
                {isEditing ? null : <BriefEditButton ref={pencilFocus.ref} onEdit={() => setIsEditing(true)} />}
                <GenerateBriefButton generation={generation} isRegenerate={isRegenerate} fieldValue={value} />
            </div>
            {isEditing && (
                // An info Callout is role="status", not "alert": the notice must be read WITH the newly
                // focused field (aria-describedby), not interrupt its announcement on every open.
                <Callout id={noticeId} tone="info" variant="outline" className={styles.briefNotice} data-testid="briefPinnedNotice">
                    {BRIEF_PINNED_NOTICE}
                </Callout>
            )}
            <BriefStateNote state={state} origin={origin} fieldValue={value} isEditing={isEditing} />
            <BriefGenerationFeedback generation={generation} />
        </div>
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
        // A labelled group: the field and its Clear/Done buttons are one unit, which is also what the
        // blur handler below treats as "still editing". (base.css resets fieldset chrome.)
        <fieldset
            aria-label={BRIEF_EDITOR_LABEL}
            className={styles.briefEditor}
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
                // title without scrolling. Enter still commits (handled below), so no newline lands.
                multiline
                fullWidth
                // Mounted only by the pencil, so focusing it never yanks focus on editor open.
                autoFocus
                inputProps={{ 'aria-label': BRIEF_LABEL, 'aria-describedby': noticeId }}
                // On the textarea itself, not the field root: the Clear button lives in the end
                // adornment, and a root handler would swallow Enter on it (preventDefault cancels
                // the button's click) and commit the old text.
                onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
                    // Mid-composition Enter/Escape belong to the IME (confirm/cancel the candidate).
                    if (e.nativeEvent.isComposing || (e.key !== 'Enter' && e.key !== 'Escape')) {
                        return;
                    }
                    // Escape steps out of the field only: claim it so the page-level ESC-to-leave
                    // and a dialog's ESC-to-close don't also fire.
                    e.preventDefault();
                    e.stopPropagation();
                    onExit(value);
                }}
                endAdornment={
                    value ? (
                        <BriefClearButton
                            onClear={() => {
                                onChange('');
                                onExit('');
                            }}
                        />
                    ) : undefined
                }
                className={styles.briefField}
                data-testid="briefField"
            />
            <BriefDoneButton onDone={() => onExit(value)} />
        </fieldset>
    );
}

interface BriefReadViewProps {
    value: string;
    state: BriefState;
    origin: BriefOrigin | undefined;
    isBriefable: boolean;
    isLine: boolean;
}

/**
 * Read view. A declined brief's caption takes the text's own place in the row — under an empty row
 * it cost a whole blank line, enough to push the review card's metadata out of view.
 */
function BriefReadView({ value, state, origin, isBriefable, isLine }: BriefReadViewProps) {
    if (isDeclinedNoteVisible({ state, fieldValue: value })) {
        return (
            <Text variant="bodySm" tone="secondary" className={styles.briefText} data-testid="briefDeclinedNote">
                {describeDeclinedBrief(origin)}
            </Text>
        );
    }
    return <BriefText text={value} emptyHint={describeEmptyBrief(state, isBriefable)} isLine={isLine} />;
}

/** The brief as plain text, or a muted hint about why there is none. */
function BriefText({ text, emptyHint, isLine }: { text: string; emptyHint: string; isLine: boolean }) {
    if (!text.trim()) {
        return (
            <Text variant="bodySm" tone="secondary" className={styles.briefText} data-testid="briefEmpty">
                {emptyHint}
            </Text>
        );
    }
    return (
        <Text variant={isLine ? 'body' : 'bodySm'} className={styles.briefText} data-testid="briefLine">
            {text}
        </Text>
    );
}

function BriefEditButton({ ref, onEdit }: { ref: Ref<HTMLButtonElement>; onEdit: () => void }) {
    return (
        <IconButton ref={ref} size="sm" aria-label="Edit brief" onClick={onEdit} data-testid="briefEditButton">
            <Pencil />
        </IconButton>
    );
}

function BriefDoneButton({ onDone }: { onDone: () => void }) {
    return (
        <IconButton
            size="sm"
            aria-label="Done editing brief"
            // Keep focus in the field on press: otherwise its blur flips to the read view first
            // and the click would land on the pencil that replaced this button.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onDone}
            data-testid="briefDoneButton"
        >
            <Check />
        </IconButton>
    );
}

function BriefClearButton({ onClear }: { onClear: () => void }) {
    return (
        <IconButton
            size="sm"
            aria-label="Clear brief"
            // mousedown, not click: a click would blur the field first and commit the
            // still-populated value before the clear lands.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClear}
            data-testid="briefClearButton"
        >
            <X />
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
                    size="sm"
                    aria-label={label}
                    disabled={isDisabled}
                    onClick={() => generation.requestGenerate(fieldValue)}
                    data-testid="briefGenerateButton"
                >
                    {generation.phase === 'loading' ? <Spinner size={16} aria-hidden="true" /> : <Sparkles />}
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
            {/* A click elsewhere on the page never dismisses a toast, so the notice is always read. */}
            <Toast
                open={generation.notice !== null}
                autoHideDuration={6000}
                onClose={generation.dismissNotice}
                message={generation.notice}
                data-testid="briefGenerateNotice"
            />
        </>
    );
}

function ReplaceConfirm({ onReplace, onKeep }: { onReplace: () => void; onKeep: () => void }) {
    return (
        <div className={styles.replaceConfirm} data-testid="briefReplaceConfirm">
            <Text variant="bodySm">{REPLACE_BRIEF_PROMPT}</Text>
            <Button size="sm" variant="solid" onClick={onReplace} data-testid="briefReplaceButton">
                Replace
            </Button>
            <Button size="sm" onClick={onKeep} data-testid="briefKeepButton">
                Keep
            </Button>
        </div>
    );
}

interface BriefStateNoteProps {
    state: BriefState;
    origin: BriefOrigin | undefined;
    fieldValue: string;
    isEditing: boolean;
}

/**
 * The at-most-one muted line under the brief that explains the row's state. `declined` is the
 * reason this exists: a text-less row would otherwise render as an ordinary empty field, leaving
 * the user unable to tell a deliberate "nothing to summarise" from a broken or pending feature.
 * Both states cost exactly one caption line, so a review card never grows taller than before.
 *
 * At rest the declined caption lives in the row (`BriefReadView`); it moves here only while the
 * field is open. It tracks the LIVE field value (see `isDeclinedNoteVisible`), so it clears on
 * the first keystroke rather than lingering over text the user is already writing.
 *
 * Rendered by BOTH variants, but `declined` only ever reaches the field one: `isBriefFirst`
 * returns false for it, so the host never picks `variant="line"` for a declined row (a line
 * variant would show this caption under an empty brief line, which reads as a bug).
 */
function BriefStateNote({ state, origin, fieldValue, isEditing }: BriefStateNoteProps) {
    if (state === 'pinnedStale') {
        return <BriefCaption text={BRIEF_STALE_MARKER} testId="briefStaleMarker" />;
    }
    if (isEditing && isDeclinedNoteVisible({ state, fieldValue })) {
        return <BriefCaption text={describeDeclinedBrief(origin)} testId="briefDeclinedNote" />;
    }
    return null;
}

function BriefCaption({ text, testId }: { text: string; testId: string }) {
    return (
        <Text as="span" variant="caption" tone="secondary" className={styles.briefCaption} data-testid={testId}>
            {text}
        </Text>
    );
}
