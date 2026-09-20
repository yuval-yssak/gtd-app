import type { ComponentProps } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './MarkdownPreview.module.css';

// Module-level so the plugin array identity is stable across renders.
const remarkPlugins = [remarkGfm];

/**
 * Every notes link opens in a new tab — external and in-app alike (product decision): the preview
 * sits inside an autosaving editor and, in the weekly review, mid-wizard, so navigating the
 * current tab away would drop the user's place. Spread first so the forced target/rel always win.
 * `ExtraProps` carries react-markdown's `node` (the hast node) — stripped so it never reaches the DOM.
 */
export function NotesLink({ node: _node, ...anchorProps }: ComponentProps<'a'> & ExtraProps) {
    return <a {...anchorProps} target="_blank" rel="noopener noreferrer" />;
}

const notesMarkdownComponents: Components = { a: NotesLink };

/**
 * Single rendering path for notes markdown (item/routine editors, inbox capture). remark-gfm
 * adds tables, strikethrough, task lists and autolinks on top of CommonMark — matching what the
 * CodeMirror editor highlights.
 */
export function MarkdownPreview({ markdown }: { markdown: string }) {
    return (
        <div className={styles.markdownBody}>
            <ReactMarkdown remarkPlugins={remarkPlugins} components={notesMarkdownComponents}>
                {markdown}
            </ReactMarkdown>
        </div>
    );
}
