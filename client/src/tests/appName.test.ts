import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_NAME } from '../lib/appName';
import { LEGAL_DOCUMENTS } from '../lib/legalDocuments';

// The product is branded "Done"; "Getting Things Done" / "GTD" are David Allen Company marks and
// may only describe the method. The Google OAuth consent screen carries the same name, and
// reviewers compare it against the homepage and legal pages, so every user-facing surface must agree.

const clientRoot = resolve(__dirname, '../..');
const readClientFile = (relativePath: string) => readFileSync(resolve(clientRoot, relativePath), 'utf8');

describe('APP_NAME', () => {
    it('is the trademark-free product name', () => {
        expect(APP_NAME).toBe('Done');
    });

    it('is the static <title> of index.html, which cannot import the constant', () => {
        expect(readClientFile('index.html')).toContain(`<title>${APP_NAME}</title>`);
    });

    it('is the only name the PWA manifest carries — no "GTD" short name', () => {
        const viteConfig = readClientFile('vite.config.ts');
        // Anchored: `name: APP_NAME,` is a substring of `short_name: APP_NAME,`, so a plain
        // toContain would pass with `name` reverted to a literal.
        expect(viteConfig).toMatch(/^\s+name: APP_NAME,$/m);
        expect(viteConfig).toMatch(/^\s+short_name: APP_NAME,$/m);
        expect(viteConfig).not.toMatch(/^\s+(short_)?name: '/m);
    });

    it('opens both legal documents as the Service', () => {
        expect(LEGAL_DOCUMENTS.privacy.markdown.startsWith(`${APP_NAME} ("the Service"`)).toBe(true);
        expect(LEGAL_DOCUMENTS.terms.markdown.startsWith(`These terms govern your use of ${APP_NAME} ("the Service"`)).toBe(true);
    });

    it('confines "Getting Things Done" in the legal text to the trademark notice', () => {
        const trademarkNotice = 'Getting Things Done® and GTD® are registered trademarks of the David Allen Company';
        expect(LEGAL_DOCUMENTS.terms.markdown).toContain(trademarkNotice);
        expect(LEGAL_DOCUMENTS.terms.markdown).toContain(`The Service is called "${APP_NAME}"`);
        const outsideNotice = (markdown: string) => markdown.replace(trademarkNotice, '');
        for (const markdown of [LEGAL_DOCUMENTS.terms.markdown, LEGAL_DOCUMENTS.privacy.markdown]) {
            expect(outsideNotice(markdown)).not.toContain('Getting Things Done');
            // "GTD" may name the method ("the GTD method"), never the Service.
            expect(outsideNotice(markdown)).not.toMatch(/\bGTD\b(?! method)/);
        }
    });
});
