import privacyPolicyMarkdown from '../legal/privacy-policy.md?raw';
import termsOfServiceMarkdown from '../legal/terms-of-service.md?raw';

/** ISO date both documents took effect; bump it (and announce in-app) whenever either text changes. */
export const LEGAL_EFFECTIVE_DATE = '2026-09-27';

export const LEGAL_CONTACT_EMAIL = 'yuval.yssak@gmail.com';

export type LegalDocumentSlug = 'privacy' | 'terms';

export interface LegalDocument {
    slug: LegalDocumentSlug;
    /** Route path — also the URL Google's OAuth consent-screen config points at. */
    path: `/${LegalDocumentSlug}`;
    title: string;
    markdown: string;
}

export const LEGAL_DOCUMENTS: Record<LegalDocumentSlug, LegalDocument> = {
    privacy: { slug: 'privacy', path: '/privacy', title: 'Privacy Policy', markdown: privacyPolicyMarkdown },
    terms: { slug: 'terms', path: '/terms', title: 'Terms of Service', markdown: termsOfServiceMarkdown },
};

/** The `## ` headings of a document in order — the page's table of contents, and what the tests pin. */
export function legalSectionHeadings(markdown: string) {
    return markdown
        .split('\n')
        .filter((line) => line.startsWith('## '))
        .map((line) => line.slice(3).trim());
}

/** URL-fragment id for a section heading, e.g. "How we use it" → "how-we-use-it". */
export function legalSectionAnchor(heading: string) {
    return heading
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}
