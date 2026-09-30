import { APP_NAME, METHOD_NAME } from './appName';

/**
 * Copy for the public homepage (`/`). Google's OAuth verification checks the homepage from the
 * branding config for four things without signing in: what the app does, why it asks for Google
 * user data and how that data is used, a link to the privacy policy, and the same product name as
 * the consent screen. Keep the text here (not inline in the component) so the tests can pin the
 * scope list against the API server's consent request and the `<noscript>` mirror in index.html.
 * Every claim must agree with `legal/privacy-policy.md` — a reviewer compares the two.
 */

/**
 * One sentence a reviewer (or crawler) reads first; mirrored verbatim in index.html's <noscript>.
 * "Getting Things Done" names the method the app follows (descriptive use, credited to its author,
 * with the trademark notice below) — never the app itself, which is "Done".
 */
export const LANDING_TAGLINE = `${APP_NAME} is a personal productivity app for capturing, organising and reviewing your tasks, built around the Getting Things Done® method by David Allen.`;

/** Same attribution as the Terms § Trademarks; shown in the landing page footer. */
export const LANDING_TRADEMARK_NOTICE = `Getting Things Done® and ${METHOD_NAME}® are registered trademarks of the David Allen Company. ${APP_NAME} follows the ${METHOD_NAME} method but is an independent project, not affiliated with, endorsed by or sponsored by the David Allen Company.`;

export const LANDING_FEATURES = [
    { title: 'Capture', body: 'Drop anything on your mind into the inbox from any device, online or offline.' },
    { title: 'Clarify', body: 'Turn each capture into a next action, a waiting-for, a someday/maybe, or a calendar entry.' },
    { title: 'Review', body: 'A guided weekly review keeps every list current, with one-line AI briefs that summarise long notes.' },
    { title: 'Do', body: 'Filter next actions by the energy, time and context you have right now.' },
] as const;

/** Matches the privacy policy: calendar sync is opt-in, briefs are generated automatically. */
export const LANDING_OPTIONALITY_NOTE =
    'Your lists work offline and sync across your devices when you are back online. Google Calendar is optional and off until you connect it. AI briefs are generated automatically for items with longer notes, and the clarify-with-AI assistant runs only when you ask it to.';

export interface GoogleDataUse {
    /** Exact OAuth scope string, as the API server requests it on connect. */
    scope: string;
    purpose: string;
}

/**
 * Why each scope of the Google Calendar connect flow is requested. Must match the `scope` list the
 * API server sends to Google in api-server/src/routes/calendar.ts (REQUIRED_CALENDAR_SCOPES plus
 * USERINFO_EMAIL_SCOPE); a unit test pins it.
 */
export const GOOGLE_CALENDAR_DATA_USES: readonly GoogleDataUse[] = [
    {
        scope: 'https://www.googleapis.com/auth/calendar.events',
        purpose: 'Read and write events on the calendars you choose, so calendar items and routines stay in sync both ways.',
    },
    {
        scope: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
        purpose: 'List your calendars so you can pick which ones to sync.',
    },
    {
        scope: 'https://www.googleapis.com/auth/calendar.calendars.readonly',
        purpose: "Read a calendar's settings, such as its time zone, so all-day and recurring events land on the right day.",
    },
    {
        scope: 'https://www.googleapis.com/auth/userinfo.email',
        purpose: 'Confirm which Google account you authorised, so the calendar is linked to the account you selected.',
    },
];

export const GOOGLE_SIGN_IN_DATA_USE =
    'Signing in with Google shares your name, email address and profile picture. They identify your account and are shown in the account switcher; nothing else is read from your Google Account unless you connect a calendar.';

/** Mirrors the privacy policy's Google API Services disclosure, including the transfer to Anthropic for the AI features. */
export const GOOGLE_LIMITED_USE_STATEMENT = `${APP_NAME} uses Google Calendar data only for calendar sync and, as described in the privacy policy, for the AI features: item briefs and the clarify-with-AI assistant, which send event titles and descriptions to Anthropic. It is never used for advertising, never sold, and never used to train machine-learning models. Disconnecting the calendar in Settings deletes the access tokens we hold.`;
