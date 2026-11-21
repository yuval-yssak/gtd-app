/** lib/legalDocuments: the legal texts are data, so the tests pin what a reviewer (Google's OAuth
 * verification, a GDPR reader) must find in them — the processors named in the privacy inventory,
 * the Limited Use disclosure, the contact address, a real effective date — plus the pure helpers
 * the page builds its table of contents from. */
import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { LEGAL_CONTACT_EMAIL, LEGAL_DOCUMENTS, LEGAL_EFFECTIVE_DATE, legalSectionAnchor, legalSectionHeadings } from '../lib/legalDocuments';

const { privacy, terms } = LEGAL_DOCUMENTS;

describe('LEGAL_EFFECTIVE_DATE', () => {
    it('is a real calendar date in ISO form, not in the future', () => {
        // dayjs without the customParseFormat plugin ignores a format argument, so round-trip instead.
        expect(LEGAL_EFFECTIVE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(dayjs(LEGAL_EFFECTIVE_DATE).format('YYYY-MM-DD')).toBe(LEGAL_EFFECTIVE_DATE);
        expect(dayjs(LEGAL_EFFECTIVE_DATE).isAfter(dayjs())).toBe(false);
    });
});

/** The connector's use of calendar data, worded identically in the policy, the landing page and the noscript mirror. */
const CONNECTOR_CALENDAR_USE = 'your calendar items and routines to Claude when it reads them on your behalf';
/** Ask Claude's use of calendar data, worded identically in the policy, the landing page and the noscript mirror. */
const ASK_CLAUDE_CALENDAR_USE = "a calendar item's title, status and notes to your Claude routine when you ask Claude about that item";

describe('privacy policy', () => {
    it('discloses Ask Claude: what it sends, to whose Claude routine, and what Done keeps', () => {
        const [, afterHeading] = privacy.markdown.split('## AI processing');
        if (afterHeading === undefined) {
            throw new Error('expected an "AI processing" section');
        }
        const [aiSection] = afterHeading.split('\n## ');
        expect(aiSection).toContain('**Ask Claude**');
        expect(aiSection).toContain('title, status, notes and your prompt to your own Claude routine');
        expect(aiSection).toContain('token (encrypted at rest), your prompt');
        expect(aiSection).toContain('one-line report');
    });

    it('lists Ask Claude among the Google Limited Use purposes, not after them', () => {
        const match = privacy.markdown.match(/Calendar data is used only to provide user-facing features of the app: ([^.]*)\./);
        if (!match) {
            throw new Error('expected the Google Limited Use "used only to" sentence');
        }
        const [, usedOnlyTo] = match;
        expect(usedOnlyTo).toContain(ASK_CLAUDE_CALENDAR_USE);
    });

    it('names every processor from the data-flow inventory', () => {
        for (const processor of ['Google Cloud', 'MongoDB Atlas', 'Cloudflare', 'Anthropic', 'GitHub', 'push services']) {
            expect(privacy.markdown).toContain(processor);
        }
    });

    it('names the Google scopes verbatim — reviewers grep for the literal scope URL', () => {
        expect(privacy.markdown).toContain('https://www.googleapis.com/auth/calendar.events');
        expect(privacy.markdown).toContain('https://www.googleapis.com/auth/calendar.calendarlist.readonly');
        expect(privacy.markdown).toContain('https://www.googleapis.com/auth/calendar.calendars.readonly');
        expect(privacy.markdown).toContain('https://www.googleapis.com/auth/userinfo.email');
        // Each scope carries its own justification — reviewers ask for a purpose per scope. The
        // full read-everything `auth/calendar` scope must not be named: the app no longer requests it.
        expect(privacy.markdown).toContain('only to confirm which Google account you authorised');
        expect(privacy.markdown).not.toMatch(/auth\/calendar(?![.\w])/);
    });

    it('carries the verbatim Google API Services Limited Use disclosure', () => {
        expect(privacy.markdown).toContain(
            'use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy]',
        );
        expect(privacy.markdown).toContain('including the Limited Use requirements');
    });

    it('states the storage regions, immediate deletion and the contact address', () => {
        expect(privacy.markdown).toContain('us-central1');
        expect(privacy.markdown).toContain('us-east-1');
        // Self-service deletion is immediate; the only 30-day window left is the emailed-request fallback.
        expect(privacy.markdown).toContain('all of the above is deleted immediately');
        expect(privacy.markdown).toContain('we will act within 30 days');
        expect(privacy.markdown).toContain(`mailto:${LEGAL_CONTACT_EMAIL}`);
    });

    it('points at the in-app Download my data / Delete my account controls instead of a roadmap promise', () => {
        expect(privacy.markdown).toContain('"Download my data" in Settings');
        expect(privacy.markdown).toContain('"Delete my account"');
        expect(privacy.markdown).not.toContain('on the roadmap');
    });

    it('discloses what the AI features send, and that no user identifier goes with briefs', () => {
        expect(privacy.markdown).toMatch(/Item briefs.*status, title and notes/);
        expect(privacy.markdown).toContain('No name, email address or user identifier accompanies them');
    });

    it('says what connecting Claude shares with Anthropic, and what of the conversation reaches the Service', () => {
        expect(privacy.markdown).toContain('Done itself sends content to Anthropic, the provider of the Claude models, for two features:');
        expect(privacy.markdown).toContain('If you connect Claude to your account (Settings → Connect Claude)');
        expect(privacy.markdown).toContain(
            "the items, routines, people and work contexts Claude reads through the connector, and your account's email address,",
        );
        expect(privacy.markdown).toContain('become part of your Claude conversation');
        // A Google recurring series is imported as a routine, so routines carry Google data too.
        expect(privacy.markdown).toContain(
            'Calendar items and calendar routines can include event titles, descriptions and locations imported from Google Calendar',
        );
        expect(privacy.markdown).toContain('including any text it writes into your account, never the rest of the conversation');
    });

    it('does not promise a briefs opt-out the server lacks — the Settings switch only hides them', () => {
        expect(privacy.markdown).not.toMatch(/turned off in Settings/);
        expect(privacy.markdown).toContain('hides them on that device but does not stop generation');
    });

    it('limits product research to usage metrics, opt-in content review that excludes Google data, and no model training', () => {
        expect(privacy.markdown).toContain('These metrics never include the text of your items');
        expect(privacy.markdown).toContain('unless you opt in through a "Help improve the product" setting');
        expect(privacy.markdown).toContain('Data received from Google Calendar is never included in such reviews, even if you opt in');
        // The opt-in sentence must not list calendar data as something opting in unlocks.
        expect(privacy.markdown).not.toContain('notes, items or calendar data for research');
        expect(privacy.markdown).toContain('never used to train or fine-tune machine-learning models');
    });

    it("keeps the Google paragraph's human-access exceptions aligned with the general rule (consent, security, law)", () => {
        expect(privacy.markdown).toContain(
            'only read by a person with your consent (for example, to answer a support request you raised), for security purposes such as investigating abuse, or when required by law',
        );
    });

    it('lists every use of Google Calendar data in the Limited Use paragraph, including the AI features that receive it', () => {
        expect(privacy.markdown).not.toContain('used only to provide the calendar-sync features');
        expect(privacy.markdown).toContain(
            `calendar sync; item briefs for calendar items, as described under "AI processing"; sending ${ASK_CLAUDE_CALENDAR_USE}, as described under "AI processing"; and, if you connect Claude`,
        );
        expect(privacy.markdown).toContain(CONNECTOR_CALENDAR_USE);
        expect(privacy.markdown).toContain('for calendar items this can include an event description imported from Google Calendar');
    });

    it('pins the inactive-account, payment-processor and previous-versions commitments', () => {
        expect(privacy.markdown).toContain('unused for 12 months may be deleted after we email a 30-day warning');
        expect(privacy.markdown).toContain('handled by a payment processor rather than by us');
        expect(privacy.markdown).toContain(
            'keeps a copy of the item as it was sent, for as long as your account exists — deleting the item or person later does not remove it from those records',
        );
        expect(privacy.markdown).toContain('never the text of your items or calendar events, and never email addresses');
        expect(privacy.markdown).toContain('a record of each service email (recipient, subject and body) is kept');
        expect(privacy.markdown).toContain('https://github.com/yuval-yssak/gtd-app/commits/main/client/src/legal/privacy-policy.md');
    });
});

describe('terms of service', () => {
    it('names the governing law and venue and links the privacy policy', () => {
        expect(terms.markdown).toContain('laws of the State of Israel');
        expect(terms.markdown).toContain('courts of Tel Aviv-Jaffa');
        expect(terms.markdown).toContain('[Privacy Policy](/privacy)');
    });

    it('reserves future fees with 30 days notice and no charge without agreement, and keeps data readable', () => {
        expect(terms.markdown).toContain('at least 30 days before any feature you already use becomes paid');
        expect(terms.markdown).toContain('never be charged without first agreeing to a price');
        expect(terms.markdown).toContain('you keep the ability to read it and to export it');
        expect(terms.markdown).not.toMatch(/for a free service, is zero/);
    });

    it('carries the David Allen Company trademark disclaimer, inactive-account notice and assignment clause', () => {
        expect(terms.markdown).toContain('registered trademarks of the David Allen Company');
        expect(terms.markdown).toContain('not affiliated with, endorsed by or sponsored by');
        expect(terms.markdown).toContain('has not been used for 12 months');
        expect(terms.markdown).toContain('We may assign these terms');
        expect(terms.markdown).toContain('allow us 30 days to try to resolve the matter informally');
        expect(terms.markdown).toContain('We will not delete an account while an export or deletion request you made is pending');
    });

    it('pins the feedback licence, severability, entire agreement and previous-versions link', () => {
        expect(terms.markdown).toContain('without any obligation of confidentiality');
        expect(terms.markdown).toContain('the rest remains in effect');
        expect(terms.markdown).toContain('are the entire agreement');
        expect(terms.markdown).toContain('https://github.com/yuval-yssak/gtd-app/commits/main/client/src/legal/terms-of-service.md');
    });

    it('routes to /terms with the title the page and the login footer show', () => {
        expect(terms).toMatchObject({ slug: 'terms', path: '/terms', title: 'Terms of Service' });
        expect(privacy).toMatchObject({ slug: 'privacy', path: '/privacy', title: 'Privacy Policy' });
    });
});

describe('legalSectionHeadings', () => {
    it('returns the ## headings in document order and ignores other heading levels', () => {
        expect(legalSectionHeadings('intro\n## One\ntext\n### not a section\n## Two\n')).toEqual(['One', 'Two']);
    });

    it('finds the sections both documents are expected to have', () => {
        expect(legalSectionHeadings(privacy.markdown)).toEqual(
            expect.arrayContaining([
                'What we collect',
                'How we use it',
                'AI processing',
                'Product research',
                'Google API Services disclosure',
                'How long we keep it',
                'Your rights',
                'Contact',
            ]),
        );
        expect(legalSectionHeadings(terms.markdown)).toEqual(
            expect.arrayContaining(['Trademarks', 'Fees', 'Feedback', 'Acceptable use', 'Limitation of liability', 'Governing law', 'General', 'Contact']),
        );
    });

    it('yields unique anchors per document, so the table of contents never links two sections to one id', () => {
        for (const { markdown } of [privacy, terms]) {
            const anchors = legalSectionHeadings(markdown).map(legalSectionAnchor);
            expect(new Set(anchors).size).toBe(anchors.length);
        }
    });
});

describe('legalSectionAnchor', () => {
    it('slugifies headings the way readers expect in a URL fragment', () => {
        expect(legalSectionAnchor('How we use it')).toBe('how-we-use-it');
        expect(legalSectionAnchor('Cookies and on-device storage')).toBe('cookies-and-on-device-storage');
        expect(legalSectionAnchor('  Trailing punctuation!  ')).toBe('trailing-punctuation');
    });
});
