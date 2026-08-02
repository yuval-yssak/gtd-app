import Skeleton from '@mui/material/Skeleton';
import { Component, lazy, type ReactNode, Suspense } from 'react';
import styles from './MarkdownNotesEditor.module.css';
import type { MarkdownNotesEditorProps } from './MarkdownNotesEditorView';

const MarkdownNotesEditorView = lazy(() => import('./MarkdownNotesEditorView'));

/**
 * Single source for the notes editor's accessible name and hint text — the visible section
 * label, the editor's aria-label and the e2e selectors must never drift apart.
 */
export const NOTES_EDITOR_LABEL = 'Notes (Markdown)';
export const NOTES_PLACEHOLDER = 'Supports **bold**, _italic_, `code`, tables, ~~strikethrough~~, lists, etc.';

type MarkdownNotesEditorPublicProps = Omit<MarkdownNotesEditorProps, 'ariaLabel'> & { ariaLabel?: string };

/**
 * Public entry point for the notes editor. Lazy-loads the CodeMirror implementation so the
 * editor bundle (CodeMirror + language data) is a separate precached chunk, not part of the
 * initial page load. If that chunk fails to load (offline tab running a pre-deploy bundle whose
 * hashed chunk URL is gone — the skipWaiting PWA edge case), it degrades to a plain textarea
 * instead of an error card: notes are user data mid-edit, so a degraded editor beats no editor.
 */
export function MarkdownNotesEditor({ ariaLabel = NOTES_EDITOR_LABEL, ...props }: MarkdownNotesEditorPublicProps) {
    const editorProps = { ...props, ariaLabel };
    return (
        <EditorChunkBoundary fallback={<PlainTextareaFallback {...editorProps} />}>
            <Suspense fallback={<Skeleton variant="rounded" className={styles.loadingFallback} data-testid="markdownNotesEditorLoading" />}>
                <MarkdownNotesEditorView {...editorProps} />
            </Suspense>
        </EditorChunkBoundary>
    );
}

function PlainTextareaFallback({ value, onValueChange, onEscape, onBlurOutside, placeholder, ariaLabel, autoFocus }: MarkdownNotesEditorProps) {
    return (
        <textarea
            className={styles.fallbackTextarea}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            onBlur={() => onBlurOutside?.()}
            onKeyDown={(e) => {
                if (e.key === 'Escape' && onEscape?.()) {
                    e.preventDefault();
                }
            }}
            placeholder={placeholder}
            aria-label={ariaLabel}
            data-testid="markdownNotesEditorFallback"
            // biome-ignore lint/a11y/noAutofocus: mirrors the editor's explicit preview→edit focus handoff
            autoFocus={autoFocus}
        />
    );
}

interface EditorChunkBoundaryProps {
    fallback: ReactNode;
    children: ReactNode;
}

/** Not AppErrorBoundary: its Alert card would replace the editing surface, while the point here
 *  is to keep the notes editable when only the CodeMirror chunk is unavailable. */
class EditorChunkBoundary extends Component<EditorChunkBoundaryProps, { didEditorFail: boolean }> {
    override state = { didEditorFail: false };

    static getDerivedStateFromError() {
        return { didEditorFail: true };
    }

    override render() {
        return this.state.didEditorFail ? this.props.fallback : this.props.children;
    }
}
