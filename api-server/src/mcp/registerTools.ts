import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from './apiClient.js';
import { registerBatchTools } from './tools/batch.js';
import { registerItemTools } from './tools/items.js';
import { registerMeTools } from './tools/me.js';
import { registerPeopleTools } from './tools/people.js';
import { registerReassignTools } from './tools/reassign.js';
import { registerRoutineTools } from './tools/routines.js';
import { registerWorkContextTools } from './tools/workContexts.js';

/**
 * Server-level usage guidance surfaced to every MCP client — mirrors
 * mcp-server/src/index.ts's SERVER_INSTRUCTIONS so the remote and stdio servers behave identically.
 */
export const SERVER_INSTRUCTIONS = [
    'After creating or editing an item, routine or person, the tool response includes a `url` field — a direct',
    'web-app link to that entity. Always show the user this `url` at the end of your reply so they can jump straight to it.',
    'The `gtd_batch` tool returns only `{ ok, count }` with no entity, so it carries no `url`; when a batch creates or',
    'updates items/routines, construct the link yourself from each op as `<web-app-origin>/item/<entityId>` or',
    '`<web-app-origin>/routine/<entityId>` (infer the origin from a `url` returned by any other tool in the session).',
    'When creating or updating a person, put contact details in the dedicated `email` and `phone` fields — never bury',
    'them in `notes`.',
    'Every `notes` field (on items, routines and people) is rendered as Markdown in the web app. Always write links there',
    'as Markdown links — `[descriptive label](https://example.com)` — never a bare URL. Prefer a label that says what the',
    'link is (page title, ticket key, sender + subject); fall back to the domain when nothing better is available.',
].join(' ');

/**
 * Registers every GTD tool group against an `McpServer`. Single source of truth shared by the
 * remote `/mcp` route; the stdio binary registers the identical set from its own copy
 * (mcp-server/src/index.ts) — kept in lockstep by mcpToolParity.test.ts.
 */
export function registerAllTools(server: McpServer, api: ApiClient): void {
    registerItemTools(server, api);
    registerRoutineTools(server, api);
    registerPeopleTools(server, api);
    registerWorkContextTools(server, api);
    registerReassignTools(server, api);
    registerBatchTools(server, api);
    registerMeTools(server, api);
}
