import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_NAME } from '../lib/appName';
import * as guideCopy from '../lib/claudeGuideContent';
import { CLAUDE_GUIDE_EXAMPLES, CLAUDE_GUIDE_PATH, CLAUDE_GUIDE_TROUBLESHOOTING } from '../lib/claudeGuideContent';
import { LEGAL_CONTACT_EMAIL, LEGAL_DOCUMENTS } from '../lib/legalDocuments';
import { ClaudeGuidePage } from '../routes/-ClaudeGuidePage';

// /claude is the public documentation URL of the Claude connector. Anthropic's connector directory
// requires a page a signed-out reader can open that explains what the connector does, how to set it
// up, at least three working example prompts, how to troubleshoot it, and where to get support.

/** The page uses router Links, so it is rendered inside a memory router. */
async function renderGuide() {
    const rootRoute = createRootRoute();
    const guideRoute = createRoute({ getParentRoute: () => rootRoute, path: CLAUDE_GUIDE_PATH, component: ClaudeGuidePage });
    const router = createRouter({ routeTree: rootRoute.addChildren([guideRoute]), history: createMemoryHistory({ initialEntries: [CLAUDE_GUIDE_PATH] }) });
    await router.load();
    return renderToStaticMarkup(<RouterProvider router={router} />);
}

/** React escapes quotes and apostrophes in text nodes; compare against the same escaping. */
const asRenderedText = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');

describe('Claude guide content', () => {
    it('gives at least the three example prompts the directory requires', () => {
        expect(CLAUDE_GUIDE_EXAMPLES.length).toBeGreaterThanOrEqual(3);
    });

    it('names the product, never the method mark, anywhere in the copy', () => {
        const copy = JSON.stringify(Object.values(guideCopy));
        expect(copy).toContain(APP_NAME);
        expect(copy).not.toMatch(/GTD|Getting Things Done/);
    });
});

describe('Claude guide page', () => {
    it('renders the connector URL, every example prompt and every troubleshooting answer', async () => {
        const html = await renderGuide();
        expect(html).toContain('data-testid="mcpConnectorUrl"');
        for (const example of CLAUDE_GUIDE_EXAMPLES) {
            expect(html).toContain(asRenderedText(example.prompt));
        }
        for (const entry of CLAUDE_GUIDE_TROUBLESHOOTING) {
            expect(html).toContain(asRenderedText(entry.problem));
        }
    });

    // Settings shows the same setup steps under a deeper heading; here they sit directly under an h2.
    it('has a heading outline with no skipped levels', async () => {
        const levels = [...(await renderGuide()).matchAll(/<h([1-6])\b/g)].map(([, level]) => Number(level));
        const skippedTo = levels.filter((level, index) => index > 0 && level > (levels[index - 1] ?? 0) + 1);
        expect(levels[0]).toBe(1);
        expect(skippedTo).toEqual([]);
    });

    it('links the privacy policy, the terms and a support address', async () => {
        const html = await renderGuide();
        expect(html).toContain(`href="${LEGAL_DOCUMENTS.privacy.path}"`);
        expect(html).toContain(`href="${LEGAL_DOCUMENTS.terms.path}"`);
        expect(html).toContain(`href="mailto:${LEGAL_CONTACT_EMAIL}"`);
    });
});
