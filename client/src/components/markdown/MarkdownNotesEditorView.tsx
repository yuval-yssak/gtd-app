import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import styles from './MarkdownNotesEditor.module.css';
import { buildNotesEditorExtensions } from './markdownEditorSetup';

export interface MarkdownNotesEditorProps {
    value: string;
    onValueChange: (next: string) => void;
    /** Claim Escape (exit-to-preview etc.). Return true when handled so the page-level ESC listener stays quiet. */
    onEscape?: () => boolean;
    /** Focus left the editor entirely — moving into the find panel does not fire this. */
    onBlurOutside?: () => void;
    /** Mount-only: read once when the CodeMirror view is created; later changes are ignored. */
    autoFocus?: boolean;
    /** Mount-only, like autoFocus. */
    placeholder?: string;
    /** Mount-only, like autoFocus. The `MarkdownNotesEditor` wrapper defaults it to the shared notes label. */
    ariaLabel: string;
}

/**
 * CodeMirror 6 markdown editor (default export so it can be React.lazy-loaded — CodeMirror and
 * the per-language highlighters stay out of the initial bundle). Use the `MarkdownNotesEditor`
 * wrapper, not this file, from app code.
 */
export default function MarkdownNotesEditorView({
    value,
    onValueChange,
    onEscape,
    onBlurOutside,
    autoFocus,
    placeholder,
    ariaLabel,
}: MarkdownNotesEditorProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    // Latest callbacks behind a stable ref so the EditorView (created once) never goes stale.
    const hooksRef = useRef({ onValueChange, onEscape, onBlurOutside });
    hooksRef.current = { onValueChange, onEscape, onBlurOutside };
    // Deliberately initial-only (useRef ignores later args, unlike the reassigned hooksRef above):
    // the view is created exactly once, and recreating it on prop change would drop selection/history.
    const initialPropsRef = useRef({ value, autoFocus, placeholder, ariaLabel });

    useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }
        const initial = initialPropsRef.current;
        const view = new EditorView({
            state: EditorState.create({
                doc: initial.value,
                extensions: buildNotesEditorExtensions(
                    {
                        onDocChanged: (nextDoc) => hooksRef.current.onValueChange(nextDoc),
                        onEscape: () => hooksRef.current.onEscape?.() ?? false,
                        onFocusLeftEditor: () => hooksRef.current.onBlurOutside?.(),
                    },
                    { ariaLabel: initial.ariaLabel, placeholder: initial.placeholder ?? '' },
                ),
            }),
            parent: container,
        });
        viewRef.current = view;
        if (initial.autoFocus) {
            view.focus();
        }
        return () => {
            view.destroy();
            viewRef.current = null;
        };
    }, []);

    // External writers (autosave Undo, cross-device live merge) update `value` without typing —
    // sync the doc. During normal typing the doc already equals `value`, so this no-ops.
    useEffect(() => {
        const view = viewRef.current;
        if (!view) {
            return;
        }
        const currentDoc = view.state.doc.toString();
        if (value === currentDoc) {
            return;
        }
        // Re-assert the caret explicitly (clamped to the new length): a whole-document change
        // with no `selection` maps the old caret through the replacement and collapses it to 0,
        // teleporting the user to the top of their notes on every Undo / remote merge.
        const anchor = Math.min(view.state.selection.main.anchor, value.length);
        view.dispatch({
            changes: { from: 0, to: currentDoc.length, insert: value },
            selection: { anchor },
        });
    }, [value]);

    return <div ref={containerRef} className={styles.editor} data-testid="markdownNotesEditor" />;
}
