import { APP_NAME } from './appName';

/**
 * Copy for the public Claude connector guide. Anthropic's connector directory links this page as the
 * connector's documentation, so it must stay readable signed out and keep at least three working
 * example prompts. Every claim about what Claude can reach must agree with the scopes the hosted
 * endpoint grants (`MCP_SUPPORTED_SCOPES` in the API server) and with `legal/privacy-policy.md`.
 */

export const CLAUDE_GUIDE_PATH = '/claude';

/** Link text on the landing page and the browser tab title. */
export const CLAUDE_GUIDE_NAV_LABEL = 'Use with Claude';

export const CLAUDE_GUIDE_TITLE = `Use ${APP_NAME} with Claude`;

export const CLAUDE_GUIDE_INTRO = `${APP_NAME} has a connector for Claude. Once it is connected, Claude can read and update your ${APP_NAME} lists in conversation: capture what is on your mind, clarify your inbox, check what you are waiting for, and get you ready for a weekly review. It works in claude.ai, the Claude desktop and mobile apps, and Claude Code.`;

export const CLAUDE_GUIDE_EXAMPLES = [
    {
        prompt: `What's in my ${APP_NAME} inbox? Help me clarify each item.`,
        outcome:
            'Claude lists your inbox, suggests what each capture should become (a next action, a waiting-for, a calendar entry, someday/maybe or trash) and updates the items you agree on.',
    },
    {
        prompt: `Add "renew my passport" to my ${APP_NAME} inbox, with a note that the current one expires in March.`,
        outcome: 'Claude captures a new inbox item with the note and gives you a link that opens it in the app.',
    },
    {
        prompt: 'What am I waiting for from other people, and which of it is overdue?',
        outcome: 'Claude reads your Waiting For list, ordered by the date each reply was expected, and points out the ones that are late.',
    },
    {
        prompt: 'I have 30 minutes and not much energy. Which next actions fit?',
        outcome: 'Claude filters your next actions by the time and energy each one needs and suggests where to start.',
    },
    {
        prompt: 'Set up a routine that reminds me to water the plants every Sunday.',
        outcome: "Claude creates a weekly routine. Its next action comes up for Sunday; when you finish it, the following Sunday's appears.",
    },
] as const;

export const CLAUDE_GUIDE_CAPABILITIES = [
    { area: 'Items', actions: 'Capture to the inbox, list and search, edit any field, mark done, reorder by priority, and move to the trash.' },
    { area: 'Routines', actions: 'Create, edit, pause and resume, change from a date onward, and delete recurring tasks.' },
    { area: 'People and work contexts', actions: 'Create, edit and delete the people and contexts your items refer to.' },
    { area: 'Briefs', actions: 'Read the one-line summary of an item, and write or regenerate it when you ask.' },
] as const;

export const CLAUDE_GUIDE_SAFETY_NOTE = `Every tool tells Claude whether it only reads or also changes your data, so Claude can ask you before it changes anything. An item Claude moves to the trash stays in your ${APP_NAME} Trash and can be restored. Deleting a routine, a person or a work context is permanent.`;

export const CLAUDE_GUIDE_ACCESS_NOTES = [
    `Claude reaches only the ${APP_NAME} account you click Allow for: its items (with their briefs), routines, people and work contexts, plus the account's email so Claude can confirm which account it is using.`,
    'It cannot read your Google Calendar credentials, your API tokens, your account settings or any other account.',
    `What Claude reads from ${APP_NAME} becomes part of your Claude conversation, which Anthropic handles under its own terms. ${APP_NAME} receives only the requests Claude makes, including any text it writes into your account, never the rest of your conversation.`,
    `To disconnect, remove the connector in Claude. Claude then forgets its access, and the sign-in it held expires within 30 days; ${APP_NAME} has no switch to end it sooner yet.`,
] as const;

export const CLAUDE_GUIDE_TROUBLESHOOTING = [
    {
        problem: 'I cannot add a custom connector',
        answer: 'On a Claude Team or Enterprise plan only an owner can add connectors, in the organization settings. Ask an owner to add it, then click Connect yourself.',
    },
    {
        problem: 'The Authorize page shows the wrong account',
        answer: `Choose "Use a different account" on that page and sign in with the Google or GitHub account your ${APP_NAME} lists are in.`,
    },
    {
        problem: 'Claude says the connector needs to be connected again',
        answer: 'The sign-in lapses after a month without use. Click Connect on the connector again (Settings → Connectors), or in Claude Code type /mcp and choose Authenticate.',
    },
    {
        problem: `A change Claude made is not showing in ${APP_NAME}`,
        answer: `The app picks up changes the next time it syncs. Open ${APP_NAME} with a connection, or reload the page.`,
    },
    {
        problem: 'Claude cannot move an item to my other account',
        answer: `Each connector reaches one account. Add a second connector for the other account; moving items between accounts is done in the ${APP_NAME} app.`,
    },
] as const;
