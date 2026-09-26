import { Children, type ComponentProps, type ReactNode, useMemo } from 'react';
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

/**
 * Only links that leave for another site get a new tab: absolute http(s) and protocol-relative
 * (`//host` starts with `/` too, so a plain "starts with /" check would keep it in-app). Route
 * paths, fragments and `mailto:` stay in the tab — a mailto in a new tab leaves a blank window.
 */
function opensNewTab(href: string | undefined) {
    return href !== undefined && /^(https?:)?\/\//i.test(href);
}

/**
 * Long-form documents: in-app routes and section anchors navigate in place (an installed PWA
 * would otherwise open a second window for its own privacy policy), external links keep the
 * new-tab treatment so the reader does not lose the document.
 */
export function DocumentLink({ node: _node, ...anchorProps }: ComponentProps<'a'> & ExtraProps) {
    return opensNewTab(anchorProps.href) ? <a {...anchorProps} target="_blank" rel="noopener noreferrer" /> : <a {...anchorProps} />;
}

/** Plain-text content of a heading — the anchors only need the literal words, not nested markup. */
function headingText(children: ReactNode) {
    return Children.toArray(children)
        .filter((child): child is string => typeof child === 'string')
        .join('');
}

// `| undefined` spelled out: the props are forwarded as an object under exactOptionalPropertyTypes.
interface MarkdownRenderOptions {
    /**
     * Stamps `id={headingId(text)}` on every `##` heading so a table of contents can deep-link to it.
     * Pass a module-level function: the memoised component map is keyed on its identity, and an inline
     * arrow would hand react-markdown a new `h2` component type — and remount every heading — per render.
     */
    headingId?: ((headingText: string) => string) | undefined;
    /** Long-form documents (legal pages): in-app links navigate in place; notes keep the new-tab default. */
    internalLinksInSameTab?: boolean | undefined;
}

interface MarkdownPreviewProps extends MarkdownRenderOptions {
    markdown: string;
}

function buildComponents({ headingId, internalLinksInSameTab }: MarkdownRenderOptions): Components {
    return {
        a: internalLinksInSameTab ? DocumentLink : NotesLink,
        ...(headingId && {
            h2: ({ node: _node, children, ...headingProps }: ComponentProps<'h2'> & ExtraProps) => (
                <h2 {...headingProps} id={headingId(headingText(children))}>
                    {children}
                </h2>
            ),
        }),
    };
}

/**
 * Single rendering path for notes markdown (item/routine editors, inbox capture) and the legal
 * pages. remark-gfm adds tables, strikethrough, task lists and autolinks on top of CommonMark —
 * matching what the CodeMirror editor highlights.
 */
export function MarkdownPreview({ markdown, headingId, internalLinksInSameTab }: MarkdownPreviewProps) {
    const components = useMemo(() => buildComponents({ headingId, internalLinksInSameTab }), [headingId, internalLinksInSameTab]);
    return (
        <div className={styles.markdownBody}>
            <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
                {markdown}
            </ReactMarkdown>
        </div>
    );
}
