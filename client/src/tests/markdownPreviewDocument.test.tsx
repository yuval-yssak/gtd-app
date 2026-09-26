/** MarkdownPreview's document mode (legal pages): `headingId` must stamp an id on every `##`
 * heading that matches the table of contents, and `internalLinksInSameTab` must drop the forced
 * new-tab target for in-app links only. Rendered with renderToStaticMarkup so the assertions cover
 * react-markdown's real output, not just the component overrides in isolation. */
import { type ComponentProps, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DocumentLink, MarkdownPreview } from '../components/markdown/MarkdownPreview';
import { LEGAL_DOCUMENTS, legalSectionAnchor, legalSectionHeadings } from '../lib/legalDocuments';

const SAMPLE = '## First section\n\nSee [terms](/terms), [contact](#contact) and [Google](https://example.com).\n\n## Second section\n';

describe('MarkdownPreview document mode', () => {
    it('stamps every ## heading with the id the table of contents links to', () => {
        for (const { markdown } of Object.values(LEGAL_DOCUMENTS)) {
            const html = renderToStaticMarkup(<MarkdownPreview markdown={markdown} headingId={legalSectionAnchor} internalLinksInSameTab />);
            // Match on the id only: the heading text itself is HTML-escaped in the output (a future
            // "Children's data" would otherwise fail for the wrong reason). The id is the contract.
            for (const heading of legalSectionHeadings(markdown)) {
                expect(html).toContain(`<h2 id="${legalSectionAnchor(heading)}">`);
            }
        }
    });

    it('keeps in-app links in the tab and sends external ones to a new tab', () => {
        const html = renderToStaticMarkup(<MarkdownPreview markdown={SAMPLE} internalLinksInSameTab />);
        expect(html).toContain('<a href="/terms">terms</a>');
        expect(html).toContain('<a href="#contact">contact</a>');
        expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">Google</a>');
    });

    it('changes nothing for notes callers that pass no options', () => {
        const html = renderToStaticMarkup(<MarkdownPreview markdown={SAMPLE} />);
        expect(html).toContain('<h2>First section</h2>');
        expect(html).toContain('<a href="/terms" target="_blank" rel="noopener noreferrer">terms</a>');
        expect(html).not.toContain(' id="');
    });
});

function renderedDocumentLinkProps(href: string) {
    const element = DocumentLink({ href, children: 'x', node: undefined });
    if (!isValidElement<ComponentProps<'a'>>(element)) throw new Error('expected a React element');
    return element.props;
}

describe('DocumentLink', () => {
    it('opens a new tab only for links that leave the site', () => {
        expect(renderedDocumentLinkProps('https://example.com').target).toBe('_blank');
        expect(renderedDocumentLinkProps('//evil.example/phish').target).toBe('_blank');
        expect(renderedDocumentLinkProps('/privacy').target).toBeUndefined();
        expect(renderedDocumentLinkProps('#contact').target).toBeUndefined();
        expect(renderedDocumentLinkProps('mailto:someone@example.com').target).toBeUndefined();
    });

    it('never forwards the hast node to the DOM on either branch', () => {
        for (const href of ['/privacy', 'https://example.com']) {
            expect('node' in renderedDocumentLinkProps(href)).toBe(false);
        }
    });
});
