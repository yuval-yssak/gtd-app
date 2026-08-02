import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './MarkdownPreview.module.css';

// Module-level so the plugin array identity is stable across renders.
const remarkPlugins = [remarkGfm];

/**
 * Single rendering path for notes markdown (item/routine editors, inbox capture). remark-gfm
 * adds tables, strikethrough, task lists and autolinks on top of CommonMark — matching what the
 * CodeMirror editor highlights.
 */
export function MarkdownPreview({ markdown }: { markdown: string }) {
    return (
        <div className={styles.markdownBody}>
            <ReactMarkdown remarkPlugins={remarkPlugins}>{markdown}</ReactMarkdown>
        </div>
    );
}
