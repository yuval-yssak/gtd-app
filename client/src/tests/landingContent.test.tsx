import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_NAME } from '../lib/appName';
import { GOOGLE_CALENDAR_DATA_USES, GOOGLE_LIMITED_USE_STATEMENT, LANDING_TAGLINE, LANDING_TRADEMARK_NOTICE } from '../lib/landingContent';
import { LEGAL_DOCUMENTS, legalSectionAnchor, legalSectionHeadings } from '../lib/legalDocuments';
import { LandingPage } from '../routes/-LandingPage';

// The public homepage is what Google's OAuth verification reads at the branding homepage URL. It
// must say what the app does, name every Google scope the API server requests and why, disclose
// the same data uses as the privacy policy, and link that policy — for a browser (the React page)
// and for a plain fetch (index.html's <noscript> mirror, which cannot import the constants).

const clientRoot = resolve(__dirname, '../..');
const readRepoFile = (relativePath: string) => readFileSync(resolve(clientRoot, relativePath), 'utf8');

/** The page uses router Links, so it is rendered inside a memory router rooted at '/'. */
async function renderLandingPage() {
    const rootRoute = createRootRoute();
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: LandingPage });
    const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]), history: createMemoryHistory({ initialEntries: ['/'] }) });
    await router.load();
    return renderToStaticMarkup(<RouterProvider router={router} />);
}

const calendarRoutesSource = readRepoFile('../api-server/src/routes/calendar.ts');

/** The exact scope list the API server sends to Google on connect, read from its source. */
function scopesRequestedOnConnect() {
    const scopeList = calendarRoutesSource.match(/const REQUIRED_CALENDAR_SCOPES = \[([^\]]+)\]/)?.[1];
    const userinfoScope = calendarRoutesSource.match(/const USERINFO_EMAIL_SCOPE = '([^']+)'/)?.[1];
    if (!scopeList || !userinfoScope) throw new Error('scope constants not found in api-server/src/routes/calendar.ts');
    return [...[...scopeList.matchAll(/'([^']+)'/g)].map(([, scope]) => scope), userinfoScope].sort();
}

describe('Google Calendar data uses', () => {
    it('name exactly the scopes the API server requests on connect, userinfo.email included', () => {
        // The two constants are only meaningful while they are what the connect flow actually sends.
        expect(calendarRoutesSource).toContain('scope: [...REQUIRED_CALENDAR_SCOPES, USERINFO_EMAIL_SCOPE]');
        const describedScopes = GOOGLE_CALENDAR_DATA_USES.map((dataUse) => dataUse.scope).sort();
        expect(describedScopes).toEqual(scopesRequestedOnConnect());
    });

    it('disclose the transfer to Anthropic that the privacy policy describes', () => {
        expect(LEGAL_DOCUMENTS.privacy.markdown).toContain('Anthropic');
        expect(GOOGLE_LIMITED_USE_STATEMENT).toContain('Anthropic');
        expect(GOOGLE_LIMITED_USE_STATEMENT).toContain('never used for advertising');
    });
});

describe('LandingPage', () => {
    it('renders the product name as the page heading and the tagline', async () => {
        const html = await renderLandingPage();
        expect(html).toContain(`>${APP_NAME}</h1>`);
        expect(html).toContain(LANDING_TAGLINE);
    });

    it('lists every requested Google scope next to its purpose', async () => {
        const html = await renderLandingPage();
        for (const dataUse of GOOGLE_CALENDAR_DATA_USES) {
            expect(html).toContain(`<code>${dataUse.scope}</code><span>${dataUse.purpose.replace(/'/g, '&#x27;')}</span>`);
        }
    });

    it('links sign-in, both legal documents and the privacy section on Google data', async () => {
        const html = await renderLandingPage();
        expect(html).toContain('href="/login"');
        expect(html).toContain(`href="${LEGAL_DOCUMENTS.privacy.path}"`);
        expect(html).toContain(`href="${LEGAL_DOCUMENTS.terms.path}"`);
        const disclosureHeading = legalSectionHeadings(LEGAL_DOCUMENTS.privacy.markdown).find((heading) => heading.startsWith('Google API Services'));
        if (!disclosureHeading) throw new Error('privacy policy lost its Google API Services disclosure section');
        expect(html).toContain(`href="${LEGAL_DOCUMENTS.privacy.path}#${legalSectionAnchor(disclosureHeading)}"`);
    });

    it('credits the Getting Things Done method to David Allen with the same trademark notice as the terms', async () => {
        const html = await renderLandingPage();
        expect(LANDING_TAGLINE).toContain('Getting Things Done® method by David Allen');
        expect(html).toContain(LANDING_TRADEMARK_NOTICE);
        expect(LEGAL_DOCUMENTS.terms.markdown).toContain('Getting Things Done® and GTD® are registered trademarks of the David Allen Company');
        // The mark names the method only — never the product, which is "Done".
        const outsideNotices = html.replace(LANDING_TRADEMARK_NOTICE, '').replace(LANDING_TAGLINE, '');
        expect(outsideNotices).not.toContain('Getting Things Done');
        expect(outsideNotices).not.toMatch(/\bGTD\b(?! method)/);
    });
});

describe('index.html <noscript> mirror', () => {
    const noscript = readRepoFile('index.html').match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1];

    it('carries the tagline verbatim, the same three links and the same data-use disclosure', () => {
        if (!noscript) throw new Error('index.html has no <noscript> homepage block');
        expect(noscript).toContain(LANDING_TAGLINE);
        expect(noscript).toContain('href="/login"');
        expect(noscript).toContain(`href="${LEGAL_DOCUMENTS.privacy.path}"`);
        expect(noscript).toContain(`href="${LEGAL_DOCUMENTS.terms.path}"`);
        expect(noscript).toContain('Google Calendar');
        expect(noscript).toContain('Anthropic');
        expect(noscript).toContain('never used for advertising');
        expect(noscript).toContain(LANDING_TRADEMARK_NOTICE);
    });
});
