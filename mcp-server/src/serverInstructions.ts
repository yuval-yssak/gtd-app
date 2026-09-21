/**
 * Server-level usage guidance surfaced to every MCP client. Lives here (not in any user's local
 * memory) so the URL-surfacing behaviour ships with the server and works for all operators.
 * Copied verbatim into api-server/src/mcp/registerTools.ts — mcpToolParity.test.ts pins the two.
 */
export const SERVER_INSTRUCTIONS = [
    'After creating or editing an item, routine or person, the tool response includes a `url` field — a direct',
    'web-app link to that entity. Always show the user this `url` at the end of your reply so they can jump straight to it.',
    'The `gtd_batch` tool returns per-op `results`, each carrying the server-stamped `updatedTs`, an `applyStatus`, and',
    'a `url` for item/routine/person writes — surface those `url`s the same way, and check `applyStatus` instead of',
    'assuming every op landed (`skipped_missing` = the target row no longer exists).',
    'When creating or updating a person, put contact details in the dedicated `email` and `phone` fields — never bury',
    'them in `notes`.',
    'Every `notes` field (on items, routines and people) is rendered as Markdown in the web app. Always write links there',
    'as Markdown links — `[descriptive label](https://example.com)` — never a bare URL. Prefer a label that says what the',
    'link is (page title, ticket key, sender + subject); fall back to the domain when nothing better is available.',
    "A brief is a one-sentence, review-oriented condensation of an item's title + notes — what the commitment is and",
    'why it is still open, never logistics. Items expose it read-only as `brief`; write it with `gtd_set_brief`.',
    "`gtd_generate_brief` asks the server's model to write the brief; `gtd_set_brief` writes your own. Prefer setting",
    'a brief you have already composed over generating one. Model briefs are also generated in the background',
    '(a server sweep every ~15 minutes), so a missing brief is not an error — it simply has not been generated yet.',
    'Briefs are only generated for OPEN items; a done or trashed item is never briefed (409 `brief_not_applicable`),',
    'though a brief written before it was closed is kept.',
].join(' ');
