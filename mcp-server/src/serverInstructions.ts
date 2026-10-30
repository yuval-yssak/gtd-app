import { FIELD_COMPLETENESS_GUIDANCE } from './tools/fieldGuidance.js';

/**
 * Server-level usage guidance surfaced to every MCP client. Lives here (not in any user's local
 * memory) so the URL-surfacing behaviour ships with the server and works for all operators.
 * Copied verbatim into api-server/src/mcp/registerTools.ts — mcpToolParity.test.ts pins the two.
 */
export const SERVER_INSTRUCTIONS = [
    FIELD_COMPLETENESS_GUIDANCE,
    'The same applies to a nextAction routine: give its `template` an `energy`, `time` and `workContextIds`.',
    'After creating or editing an item, routine, person or work context, the tool response includes a `url` field — a direct',
    'web-app link to that entity. Always show the user this `url` at the end of your reply so they can jump straight to it.',
    'The `gtd_batch` tool returns per-op `results`, each carrying the server-stamped `updatedTs`, an `applyStatus`, and',
    'a `url` for item/routine/person/workContext writes — surface those `url`s the same way, and check `applyStatus` instead of',
    'assuming every op landed (`skipped_missing` = the target row no longer exists).',
    'When creating or updating a person, put contact details in the dedicated `email` and `phone` fields — never bury',
    'them in `notes`.',
    'Every `notes` field (on items, routines and people) is rendered as Markdown in the web app. Always write links there',
    'as Markdown links — `[descriptive label](https://example.com)` — never a bare URL. Prefer a label that says what the',
    'link is (page title, ticket key, sender + subject); fall back to the domain when nothing better is available.',
    "A brief is a one-sentence, review-oriented condensation of an item's title + notes — what the commitment is and",
    'why it is still open, never logistics. Items expose it read-only as `brief`. Leave briefs to the server: a',
    'background sweep (every ~15 minutes) briefs every open item and re-briefs it whenever the title or notes change.',
    'Items whose notes are too short, or hold nothing worth condensing, end up `state: "declined"` with no text — that',
    'is expected, not something to fix. A missing brief is not an error — it simply has not been generated yet.',
    'Do NOT set or generate briefs as part of creating or editing items. Call `gtd_set_brief` only when the user explicitly asks for a brief',
    'worded their way: an authored brief is pinned, the sweep never refreshes it, and it goes stale as the notes evolve.',
    "`gtd_generate_brief` asks the server's model for a brief immediately — use it only when the user wants one now.",
    'Briefs are only generated for OPEN items; a done or trashed item is never briefed (409 `brief_not_applicable`),',
    'though a brief written before it was closed is kept.',
].join(' ');
