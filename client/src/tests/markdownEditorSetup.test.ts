import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNotesEditorExtensions, focusLeftEditor, markdownLanguageSupport } from '../components/markdown/markdownEditorSetup';

function parsedNodeNames(doc: string) {
    const state = EditorState.create({ doc, extensions: markdownLanguageSupport() });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000);
    if (!tree) throw new Error('expected the markdown parse to complete');
    const names = new Set<string>();
    tree.iterate({
        enter: (node) => {
            names.add(node.name);
        },
    });
    return names;
}

describe('markdownLanguageSupport', () => {
    it('parses GFM tables', () => {
        const names = parsedNodeNames('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
        expect(names).toContain('Table');
        expect(names).toContain('TableHeader');
    });

    it('parses GFM strikethrough', () => {
        expect(parsedNodeNames('some ~~gone~~ text')).toContain('Strikethrough');
    });

    it('parses GFM task lists', () => {
        expect(parsedNodeNames('- [x] done thing\n- [ ] open thing\n')).toContain('TaskMarker');
    });

    it('parses fenced code blocks with an info string', () => {
        const names = parsedNodeNames('```ts\nconst x = 1;\n```\n');
        expect(names).toContain('FencedCode');
        expect(names).toContain('CodeInfo');
    });

    it('still parses core markdown (headings, emphasis, links)', () => {
        const names = parsedNodeNames('# Title\n\n*em* [link](https://example.com)\n');
        expect(names).toContain('ATXHeading1');
        expect(names).toContain('Emphasis');
        expect(names).toContain('Link');
    });
});

describe('buildNotesEditorExtensions', () => {
    const noopHooks = { onDocChanged: () => undefined, onEscape: () => false, onFocusLeftEditor: () => undefined };

    it('allows multiple selection ranges (multi-cursor editing)', () => {
        const state = EditorState.create({
            doc: 'foo bar foo',
            extensions: buildNotesEditorExtensions(noopHooks, { ariaLabel: 'Notes (Markdown)', placeholder: '' }),
        });
        // Select both "foo" occurrences; without allowMultipleSelections the update would
        // collapse the selection down to the main range.
        const next = state.update({ selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(8, 11)]) });
        expect(next.state.selection.ranges).toHaveLength(2);
    });
});

describe('focusLeftEditor', () => {
    // The DOM Node global doesn't exist in the node test environment — stub it so the
    // `instanceof Node` guard inside focusLeftEditor can classify our fake targets.
    class FakeNode {}
    beforeEach(() => {
        vi.stubGlobal('Node', FakeNode);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const rootContaining = (contained: unknown) => ({ contains: (n: globalThis.Node) => Object.is(n, contained) });

    it('reports left when focus moved outside the editor root', () => {
        const outside = new FakeNode() as unknown as globalThis.Node;
        expect(focusLeftEditor({ relatedTarget: null }, rootContaining(null))).toBe(true);
        expect(focusLeftEditor({ relatedTarget: outside }, rootContaining('something else'))).toBe(true);
    });

    it('reports not-left when focus moved into a child of the editor root (e.g. find panel)', () => {
        const panelInput = new FakeNode() as unknown as globalThis.Node;
        expect(focusLeftEditor({ relatedTarget: panelInput }, rootContaining(panelInput))).toBe(false);
    });

    it('treats a non-Node EventTarget (e.g. window) as leaving, even if contains() would claim it', () => {
        const windowLike = { addEventListener: () => undefined } as unknown as EventTarget;
        expect(focusLeftEditor({ relatedTarget: windowLike }, { contains: () => true })).toBe(true);
    });
});
