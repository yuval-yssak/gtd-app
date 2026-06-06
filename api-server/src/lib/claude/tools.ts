import type Anthropic from '@anthropic-ai/sdk';
import type { Filter } from 'mongodb';
import calendarIntegrationsDAO from '../../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../../dataAccess/itemsDAO.js';
import peopleDAO from '../../dataAccess/peopleDAO.js';
import workContextsDAO from '../../dataAccess/workContextsDAO.js';
import type { CalendarIntegrationInterface, ItemInterface, ItemStatus, PersonInterface, WorkContextInterface } from '../../types/entities.js';
import { buildCalendarProvider } from '../buildCalendarProvider.js';

/**
 * Read-only tools the clarify agent can call. Every tool is executed by THIS dispatcher (never by
 * the model) and every DAO read is scoped to `ownerUserId` — which is the item's owner, injected
 * server-side. The model cannot widen scope: any `user` it might emit is ignored.
 *
 * Results are bounded (capped arrays, trimmed fields) because they are untrusted DB content
 * flowing into the model context — both a token-budget and a prompt-injection concern.
 */

const SEARCH_ITEMS_MAX_LIMIT = 25;

/**
 * Resolved calendar access for the item owner, computed ONCE before the loop. Holding it stable for
 * the whole request keeps the cached tool/prefix consistent and avoids re-resolving per tool call.
 * The OAuth credentials live here server-side and never enter the model context.
 */
export interface CalendarContext {
    integration: CalendarIntegrationInterface;
    calendarId: string;
}

/** Context passed to every tool dispatch. Owner is injected here, never trusted from the model. */
export interface ToolContext {
    ownerUserId: string;
    calendar?: CalendarContext;
}

const GET_CALENDAR_EVENTS_TOOL: Anthropic.Tool = {
    name: 'getCalendarEvents',
    description:
        "List the user's Google Calendar events in a time window (ISO 'since'/'until'). Call this when the item references a meeting or a time so you can ground the clarification in the real schedule — e.g. to find the event a note should attach to, or to check availability.",
    input_schema: {
        type: 'object',
        properties: {
            since: { type: 'string', description: 'Start of the window, ISO 8601.' },
            until: { type: 'string', description: 'End of the window, ISO 8601.' },
        },
        required: ['since', 'until'],
        additionalProperties: false,
    },
};

const BASE_CLARIFY_TOOLS: Anthropic.Tool[] = [
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

/** The tool list for a request — includes getCalendarEvents only when the owner has a calendar. */
export function buildClarifyTools(hasCalendar: boolean): Anthropic.Tool[] {
    return hasCalendar ? [...BASE_CLARIFY_TOOLS, GET_CALENDAR_EVENTS_TOOL] : BASE_CLARIFY_TOOLS;
}

/**
 * Resolves the owner's active calendar (integration + the default enabled calendar to read from),
 * or undefined if they have none. Done once, up front. Failures resolve to undefined — a missing
 * calendar just omits the tool rather than failing the whole clarify request.
 */
export async function resolveCalendarContext(ownerUserId: string): Promise<CalendarContext | undefined> {
    try {
        const integrations = await calendarIntegrationsDAO.findByUserDecrypted(ownerUserId);
        const integration = integrations.find((i) => i.status !== 'suspended' && i.status !== 'revoked');
        if (!integration) {
            return undefined;
        }
        const configs = await calendarSyncConfigsDAO.findEnabledByIntegration(integration._id);
        const config = configs.find((cfg) => cfg.isDefault) ?? configs[0];
        if (!config) {
            return undefined;
        }
        return { integration, calendarId: config.calendarId };
    } catch (err) {
        // Calendar is optional enrichment — a broken/undecryptable integration (e.g. a row encrypted
        // under a rotated key) must NOT fail the whole clarify request. Degrade to no-calendar.
        // Log only the user id + message (decrypt errors carry no plaintext).
        console.warn(`[resolveCalendarContext] calendar resolution failed for user=${ownerUserId}: ${err instanceof Error ? err.message : 'unknown'}`);
        return undefined;
    }
}

interface SearchItemsInput {
    query: string;
    statuses?: ItemStatus[];
    limit?: number;
}

interface GetCalendarEventsInput {
    since: string;
    until: string;
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

async function getCalendarEvents(calendar: CalendarContext, ownerUserId: string, input: GetCalendarEventsInput) {
    // Credentials live in `calendar.integration` (decrypted server-side) and never enter the model
    // context — only the resulting event summaries do.
    const provider = buildCalendarProvider(calendar.integration, ownerUserId);
    const events = await provider.listEvents(calendar.calendarId, input.since, input.until);
    return events.map((e) => ({ id: e.id, title: e.title, timeStart: e.timeStart, timeEnd: e.timeEnd, ...(e.allDay ? { allDay: true } : {}) }));
}

/**
 * Executes one tool call, scoped to `ctx.ownerUserId`. Returns a JSON-serializable result, or an
 * error envelope the loop turns into an `is_error` tool_result so the model can adapt rather than
 * the whole request failing. `input` is the model's already-parsed object — never re-parsed from a
 * string, and the owner / calendar context is injected here, never trusted from the model.
 */
export async function dispatchTool(name: string, input: unknown, ctx: ToolContext): Promise<{ ok: true; result: unknown } | { ok: false; message: string }> {
    try {
        switch (name) {
            case 'listWorkContexts':
                return { ok: true, result: await listWorkContexts(ctx.ownerUserId) };
            case 'listPeople':
                return { ok: true, result: await listPeople(ctx.ownerUserId) };
            case 'searchItems': {
                // Defense-in-depth: the SDK already validates against `input_schema`, but a
                // non-conforming model turn shouldn't reach the DAO with a bad query.
                const parsed = input as SearchItemsInput;
                if (typeof parsed?.query !== 'string' || parsed.query.length === 0) {
                    return { ok: false, message: 'searchItems requires a non-empty "query" string.' };
                }
                return { ok: true, result: await searchItems(ctx.ownerUserId, parsed) };
            }
            case 'getCalendarEvents': {
                if (!ctx.calendar) {
                    return { ok: false, message: 'No calendar is connected for this account.' };
                }
                const parsed = input as GetCalendarEventsInput;
                if (typeof parsed?.since !== 'string' || typeof parsed?.until !== 'string') {
                    return { ok: false, message: 'getCalendarEvents requires ISO "since" and "until" strings.' };
                }
                return { ok: true, result: await getCalendarEvents(ctx.calendar, ctx.ownerUserId, parsed) };
            }
            default:
                return { ok: false, message: `Unknown tool: ${name}` };
        }
    } catch (err) {
        return { ok: false, message: `Tool "${name}" failed: ${err instanceof Error ? err.message : 'unknown error'}` };
    }
}
