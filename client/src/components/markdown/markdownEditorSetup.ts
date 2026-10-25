import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension, Prec } from '@codemirror/state';
import { crosshairCursor, drawSelection, EditorView, keymap, placeholder, rectangularSelection } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * Behaviour hooks the host component supplies. Kept as a single object (a domain concept: the
 * editor's outward-facing behaviour) rather than loose callback args.
 */
export interface NotesEditorHooks {
    onDocChanged: (nextDoc: string) => void;
    /** Return true to claim the key (CodeMirror then calls preventDefault). */
    onEscape: () => boolean;
    /** Fired only when focus left the editor entirely (not moves into e.g. the search panel). */
    onFocusLeftEditor: () => void;
}

export interface NotesEditorText {
    ariaLabel: string;
    placeholder: string;
}

/**
 * Markdown language support with GFM (tables, strikethrough, task lists — `markdownLanguage`
 * is the GFM dialect; the default base is CommonMark-only) and lazily-loaded syntax
 * highlighting inside fenced code blocks.
 */
export function markdownLanguageSupport() {
    return markdown({ base: markdownLanguage, codeLanguages: languages });
}

// typeof guard keeps this callable where the DOM Node global is absent (node-env unit tests).
function isDomNode(target: EventTarget | null): target is Node {
    return typeof Node !== 'undefined' && target instanceof Node;
}

/**
 * True when a blur event means focus left the editor as a whole — moving focus into a child of
 * the editor root (e.g. the find/replace panel) must not count as leaving.
 */
export function focusLeftEditor(event: Pick<FocusEvent, 'relatedTarget'>, editorRoot: Pick<HTMLElement, 'contains'>) {
    const next = event.relatedTarget;
    return !(isDomNode(next) && editorRoot.contains(next));
}

/**
 * Editor colours reference the design-system tokens, so a light/dark switch applies without any JS
 * re-theming.
 */
const notesHighlightStyle = HighlightStyle.define([
    { tag: tags.heading1, fontWeight: '700', fontSize: '1.35em' },
    { tag: tags.heading2, fontWeight: '700', fontSize: '1.2em' },
    { tag: tags.heading, fontWeight: '700' },
    { tag: tags.strong, fontWeight: '700' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.link, color: 'var(--color-accent)', textDecoration: 'underline' },
    { tag: tags.url, color: 'var(--color-accent)' },
    { tag: tags.monospace, background: 'var(--color-code-bg)', borderRadius: '0.1875rem' },
    { tag: tags.quote, color: 'var(--color-text-secondary)', fontStyle: 'italic' },
    { tag: tags.contentSeparator, color: 'var(--color-text-secondary)' },
    // Structural markers: #, *, >, ``` fences, table pipes — de-emphasised like editor themes do.
    { tag: [tags.processingInstruction, tags.meta, tags.punctuation], color: 'var(--color-text-secondary)' },
    // Tags below only apply inside fenced code blocks (via codeLanguages).
    { tag: tags.keyword, color: 'var(--color-accent)' },
    { tag: [tags.string, tags.special(tags.string)], color: 'var(--color-status-success)' },
    { tag: tags.comment, color: 'var(--color-text-disabled)', fontStyle: 'italic' },
    { tag: [tags.number, tags.bool, tags.atom], color: 'var(--color-status-warning)' },
    { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: 'var(--color-accent-secondary)' },
    { tag: [tags.typeName, tags.propertyName], color: 'var(--color-status-info)' },
]);

export function buildNotesEditorExtensions(hooks: NotesEditorHooks, text: NotesEditorText): Extension {
    return [
        markdownLanguageSupport(),
        history(),
        EditorView.lineWrapping,
        // Multi-cursor à la VS Code: Alt-click adds a caret, Mod-d (in searchKeymap) selects the
        // next occurrence, Alt-drag makes a rectangular selection. drawSelection is required —
        // the native DOM selection can only render one range.
        EditorState.allowMultipleSelections.of(true),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),
        highlightSelectionMatches(),
        placeholder(text.placeholder),
        // Playwright/screen readers address the editor by this name — keep in sync with the
        // TextField label it replaced ("Notes (Markdown)"). spellcheck restores the browser
        // proofing the old <textarea> had by default (contenteditable defaults it off).
        EditorView.contentAttributes.of({ 'aria-label': text.ariaLabel, spellcheck: 'true' }),
        EditorView.updateListener.of((update) => {
            if (update.docChanged) {
                hooks.onDocChanged(update.state.doc.toString());
            }
        }),
        EditorView.domEventHandlers({
            blur: (event, view) => {
                if (focusLeftEditor(event, view.dom)) {
                    hooks.onFocusLeftEditor();
                }
                return false;
            },
        }),
        // searchKeymap first: its Escape (close find panel) must win over the host's Escape.
        // markdown() already contributes Enter/Backspace bindings that continue/unwrap lists.
        keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
        Prec.lowest(keymap.of([{ key: 'Escape', run: () => hooks.onEscape() }])),
        syntaxHighlighting(notesHighlightStyle),
    ];
}
