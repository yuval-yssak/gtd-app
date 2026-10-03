import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_NAME } from '../lib/appName';
import { formatPageTitle } from '../lib/pageTitle';

// The browser tab must say which page is open ("Inbox · Done"), and the page name must be the
// one the navigation uses, so a tab and the nav entry that opened it read the same.

const clientRoot = resolve(__dirname, '../..');
const readClientFile = (relativePath: string) => readFileSync(resolve(clientRoot, relativePath), 'utf8');

/** `{ label: 'Inbox', …, to: '/inbox' }` pairs from the nav config, read from source like appName.test.ts does for index.html. */
function navEntries() {
    const appNav = readClientFile('src/components/AppNav.tsx');
    return [...appNav.matchAll(/label: '([^']+)',[^}]*to: '(\/[^']+)'/g)].map(([, label, to]) => ({ label, to }));
}

describe('formatPageTitle', () => {
    it('suffixes the page name with the app name', () => {
        expect(formatPageTitle('Inbox')).toBe(`Inbox · ${APP_NAME}`);
    });

    it('falls back to the bare app name when there is no page name', () => {
        expect(formatPageTitle(undefined)).toBe(APP_NAME);
        expect(formatPageTitle('')).toBe(APP_NAME);
        expect(formatPageTitle('   ')).toBe(APP_NAME);
    });

    it('trims an entity title so a stray space never dangles before the separator', () => {
        expect(formatPageTitle('  Call Dana ')).toBe(`Call Dana · ${APP_NAME}`);
    });
});

describe('every page sets the tab title', () => {
    it('uses the nav label as the tab title on every page the nav links to', () => {
        const entries = navEntries();
        expect(entries.length).toBeGreaterThanOrEqual(14);
        for (const { label, to } of entries) {
            const routeSource = readClientFile(`src/routes/_authenticated${to}.tsx`);
            expect(routeSource, `${to} should call useDocumentTitle('${label}')`).toContain(`useDocumentTitle('${label}')`);
        }
    });

    it('titles entity pages after the entity and the public pages after their purpose', () => {
        expect(readClientFile('src/routes/_authenticated/item.$itemId.tsx')).toContain("|| 'Edit item')");
        expect(readClientFile('src/routes/_authenticated/person.$personId.tsx')).toContain("|| 'Edit person')");
        expect(readClientFile('src/routes/_authenticated/routine.$routineId.tsx')).toContain("|| 'Edit routine')");
        expect(readClientFile('src/routes/_authenticated/process-inbox.tsx')).toContain("useDocumentTitle('Process Inbox')");
        expect(readClientFile('src/routes/login.tsx')).toContain("useDocumentTitle('Sign in')");
        expect(readClientFile('src/routes/-LegalPage.tsx')).toContain('useDocumentTitle(legalDocument.title)');
        // The landing page is the app's front door — the bare app name is the right title there.
        expect(readClientFile('src/routes/-LandingPage.tsx')).toContain('useDocumentTitle(undefined)');
    });
});
