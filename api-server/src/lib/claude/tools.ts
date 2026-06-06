import type Anthropic from '@anthropic-ai/sdk';
import type { Filter } from 'mongodb';
import itemsDAO from '../../dataAccess/itemsDAO.js';
import peopleDAO from '../../dataAccess/peopleDAO.js';
import workContextsDAO from '../../dataAccess/workContextsDAO.js';
import type { ItemInterface, ItemStatus, PersonInterface, WorkContextInterface } from '../../types/entities.js';

/**
 * Read-only tools the clarify agent can call. Every tool is executed by THIS dispatcher (never by
 * the model) and every DAO read is scoped to `ownerUserId` — which is the item's owner, injected
 * server-side. The model cannot widen scope: any `user` it might emit is ignored.
 *
 * Results are bounded (capped arrays, trimmed fields) because they are untrusted DB content
 * flowing into the model context — both a token-budget and a prompt-injection concern.
 */

const SEARCH_ITEMS_MAX_LIMIT = 25;

/** Tool definitions sent to the API. Descriptions are prescriptive ("Call this when…") per Sonnet 4.6 guidance. */
export const CLARIFY_TOOLS: Anthropic.Tool[] = [
    {
        name: 'listWorkContexts',
        description:
            "List the user's work contexts (e.g. '@phone', '@errands'). Call this when clarifying an item into a nextAction so you can assign the right contextIds, or to check whether a context already exists before suggesting one.",
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'listPeople',
        description:
            "List the user's saved people (id, name, optional email). Call this when an item mentions a person by name so you can resolve them to a peopleId or a waitingForPersonId, rather than guessing.",
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'searchItems',
        description:
            "Search the user's existing items by a case-insensitive substring of title or notes. Call this to check for related or duplicate items before proposing changes, so the clarification is grounded in what already exists.",
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Substring to match against item title and notes.' },
                statuses: {
                    type: 'array',
                    items: { type: 'string', enum: ['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe', 'done', 'trash'] },
                    description: 'Optional status filter. Omit to search all non-trash items.',
                },
                limit: { type: 'integer', description: `Max results (1–${SEARCH_ITEMS_MAX_LIMIT}). Defaults to 10.` },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
];

interface SearchItemsInput {
    query: string;
    statuses?: ItemStatus[];
    limit?: number;
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function listWorkContexts(ownerUserId: string) {
    const rows = await workContextsDAO.findArray<WorkContextInterface>({ user: ownerUserId });
    return rows.map((c) => ({ id: c._id, name: c.name }));
}

async function listPeople(ownerUserId: string) {
    const rows = await peopleDAO.findArray<PersonInterface>({ user: ownerUserId });
    // Omit phone / notes — minimize the PII surface handed to the model.
    return rows.map((p) => ({ id: p._id, name: p.name, ...(p.email ? { email: p.email } : {}) }));
}

async function searchItems(ownerUserId: string, input: SearchItemsInput) {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), SEARCH_ITEMS_MAX_LIMIT);
    const filter: Filter<ItemInterface> = {
        user: ownerUserId,
        status: input.statuses ? { $in: input.statuses } : { $ne: 'trash' },
    };
    const escaped = escapeRegex(input.query);
    const regex = { $regex: escaped, $options: 'i' };
    filter.$or = [{ title: regex }, { notes: regex }];
    const rows = await itemsDAO.findArray<ItemInterface>(filter, { limit, sort: { updatedTs: -1 } });
    return rows.map((i) => ({ id: i._id, title: i.title, status: i.status, ...(i.notes ? { notes: i.notes.slice(0, 500) } : {}) }));
}

/**
 * Executes one tool call, scoped to `ownerUserId`. Returns a JSON-serializable result, or an
 * error envelope the loop turns into an `is_error` tool_result so the model can adapt rather than
 * the whole request failing. `input` is the model's already-parsed object — never re-parsed from a
 * string, and the `user`/owner is injected here, never trusted from the model.
 */
export async function dispatchTool(name: string, input: unknown, ownerUserId: string): Promise<{ ok: true; result: unknown } | { ok: false; message: string }> {
    try {
        switch (name) {
            case 'listWorkContexts':
                return { ok: true, result: await listWorkContexts(ownerUserId) };
            case 'listPeople':
                return { ok: true, result: await listPeople(ownerUserId) };
            case 'searchItems': {
                // Defense-in-depth: the SDK already validates against `input_schema`, but a
                // non-conforming model turn shouldn't reach the DAO with a bad query.
                const parsed = input as SearchItemsInput;
                if (typeof parsed?.query !== 'string' || parsed.query.length === 0) {
                    return { ok: false, message: 'searchItems requires a non-empty "query" string.' };
                }
                return { ok: true, result: await searchItems(ownerUserId, parsed) };
            }
            default:
                return { ok: false, message: `Unknown tool: ${name}` };
        }
    } catch (err) {
        return { ok: false, message: `Tool "${name}" failed: ${err instanceof Error ? err.message : 'unknown error'}` };
    }
}
