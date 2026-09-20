import { type ComponentProps, isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { NotesLink } from '../components/markdown/MarkdownPreview';

/** Calls the render function directly (no DOM in vitest) and asserts on the element's props. */
function renderedAnchorProps(props: Parameters<typeof NotesLink>[0]) {
    const element = NotesLink(props);
    if (!isValidElement<ComponentProps<'a'>>(element)) throw new Error('expected a React element');
    return element.props;
}

describe('NotesLink', () => {
    it('forces a new-tab target with the opener-safe rel and never forwards the hast node to the DOM', () => {
        const props = renderedAnchorProps({ href: 'https://example.com/docs', children: 'docs', node: undefined });
        expect(props.href).toBe('https://example.com/docs');
        expect(props.target).toBe('_blank');
        expect(props.rel).toBe('noopener noreferrer');
        expect('node' in props).toBe(false);
    });

    it('does not let markdown-authored target/rel win over the forced values', () => {
        const props = renderedAnchorProps({ href: '/item/abc', target: '_self', rel: 'opener' });
        expect(props.target).toBe('_blank');
        expect(props.rel).toBe('noopener noreferrer');
    });
});
