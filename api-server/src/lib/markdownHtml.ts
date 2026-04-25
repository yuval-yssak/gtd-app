import { marked } from 'marked';
import TurndownService from 'turndown';

const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });

/** Converts Markdown to HTML for outbound GCal push. */
export function markdownToHtml(markdown: string): string {
    return marked.parse(markdown, { async: false }) as string;
}

/** Converts HTML (from GCal) to Markdown for inbound storage. */
export function htmlToMarkdown(html: string): string {
    return turndown.turndown(html);
}
