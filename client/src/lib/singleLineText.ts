/**
 * An item's title and brief are single-line values: they are shown on one wrapping line in the
 * editor, the weekly review and every list row. Their fields are `multiline` so a long value
 * wraps into view instead of scrolling sideways — which also means a paste, drop or autofill can
 * now carry real newlines into a value that has nowhere to render them.
 *
 * Collapsing them to spaces keeps the pasted words (dropping the line breaks would run the last
 * word of one line into the first of the next) without letting the layout break.
 *
 * This guards FIELD ENTRY only. Values arriving from the server, the sync log or the brief model
 * do not pass through here, so "a stored title has no newlines" is not an invariant to rely on.
 *
 * Used by the item editor's title and brief and by the routine editor's title — every field that
 * wraps for readability but stores a one-line value.
 */
export function collapseToSingleLine(text: string): string {
    // `[\r\n]+` rather than `\r?\n`: a lone CR (some spreadsheet and legacy-exporter copies) is a
    // line break too, and would otherwise survive as an invisible control character in list rows.
    return text.replace(/\s*[\r\n]+\s*/g, ' ');
}
