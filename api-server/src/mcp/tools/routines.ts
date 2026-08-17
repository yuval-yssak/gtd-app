// COPIED from mcp-server/src/tools/routines.ts — source of truth. Keep in sync (see mcpToolParity.test.ts).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../apiClient.js';
import { accountSchema, defineTool, idSchema, notesSchema, registerOne, requestOptsFromArgs } from './types.js';

/**
 * Routine CRUD + composite gestures (pause/resume/split). Routines are recurring task templates
 * — server-managed fields (sync anchors, exception list, split-history backref, deprecated
 * fields) are not exposed; the route layer rejects them with `forbidden_field` regardless.
 * Multi-account: every tool accepts an optional `account`.
 */

const routineTemplateSchema = z
    .object({
        workContextIds: z.array(z.string()).optional(),
        peopleIds: z.array(z.string()).optional(),
        energy: z.enum(['low', 'medium', 'high']).optional(),
        time: z.number().nonnegative().optional(),
        focus: z.boolean().optional(),
        urgent: z.boolean().optional(),
        notes: notesSchema,
    })
    .strict();

const calendarItemTemplateSchema = z
    .object({
        timeOfDay: z.string().regex(/^\d{2}:\d{2}$/),
        duration: z.number().positive(),
    })
    .strict();

const recurrenceAnchorSchema = z
    .enum(['floating', 'fixed'])
    .optional()
    .describe(
        'nextAction routines only. "floating" (default if omitted and rrule has no BYMONTHDAY/BYDAY): the next ' +
            'occurrence lands N periods after the day the item was actually completed. "fixed" (default if omitted ' +
            'and rrule has BYMONTHDAY/BYDAY): the next occurrence is always pinned to a specific day-of-period ' +
            'regardless of completion date.',
    );

const listRoutines = defineTool({
    name: 'gtd_list_routines',
    description: "List the user's routines. Sorted by updatedTs DESC. Default limit 100, max 500.",
    inputSchema: {
        limit: z.number().int().positive().max(500).optional(),
        cursor: z.string().optional(),
        since: z.string().optional().describe('ISO datetime; only routines with updatedTs > since.'),
        account: accountSchema,
    },
    handler: async (args, api) =>
        api.request(
            'GET',
            '/v1/routines',
            undefined,
            { limit: args.limit, cursor: args.cursor, since: args.since },
            requestOptsFromArgs({ account: args.account }),
        ),
});

const getRoutine = defineTool({
    name: 'gtd_get_routine',
    description: 'Fetch a single routine by id. 404 if missing.',
    inputSchema: { id: idSchema, account: accountSchema },
    handler: async (args, api) =>
        api.request('GET', `/v1/routines/${encodeURIComponent(args.id)}`, undefined, undefined, requestOptsFromArgs({ account: args.account })),
});

const createRoutine = defineTool({
    name: 'gtd_create_routine',
    description:
        'Create a recurring task template. Required: title, routineType, rrule, template. ' +
        'Use routineType=nextAction for a recurring next-action item, or calendar for a recurring calendar event ' +
        '(calendar routines also need calendarItemTemplate.timeOfDay/duration).',
    inputSchema: {
        title: z.string().min(1),
        routineType: z.enum(['nextAction', 'calendar']),
        rrule: z.string().regex(/FREQ=/),
        recurrenceAnchor: recurrenceAnchorSchema,
        template: routineTemplateSchema,
        active: z.boolean(),
        startDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        calendarItemTemplate: calendarItemTemplateSchema.optional(),
        calendarEventId: z.string().optional(),
        calendarIntegrationId: z.string().optional(),
        calendarSyncConfigId: z.string().optional(),
        account: accountSchema,
    },
    handler: async ({ account, ...body }, api) => api.request('POST', '/v1/routines', body, undefined, requestOptsFromArgs({ account })),
});

const updateRoutine = defineTool({
    name: 'gtd_update_routine',
    description: 'Update fields on an existing routine. At least one writable field must be present.',
    inputSchema: {
        id: idSchema,
        title: z.string().min(1).optional(),
        routineType: z.enum(['nextAction', 'calendar']).optional(),
        rrule: z.string().regex(/FREQ=/).optional().describe('RFC 5545 RRULE string. Must contain FREQ=.'),
        recurrenceAnchor: recurrenceAnchorSchema,
        template: routineTemplateSchema.optional(),
        active: z.boolean().optional(),
        startDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        calendarItemTemplate: calendarItemTemplateSchema.optional(),
        calendarEventId: z.string().optional(),
        calendarIntegrationId: z.string().optional(),
        calendarSyncConfigId: z.string().optional(),
        account: accountSchema,
    },
    handler: async ({ id, account, ...patch }, api) =>
        api.request('PATCH', `/v1/routines/${encodeURIComponent(id)}`, patch, undefined, requestOptsFromArgs({ account })),
});

const deleteRoutine = defineTool({
    name: 'gtd_delete_routine',
    description: 'Delete a routine. Idempotent — deleting a missing routine returns alreadyDeleted:true. Cascades GCal teardown.',
    inputSchema: { id: idSchema, account: accountSchema },
    handler: async (args, api) =>
        api.request('DELETE', `/v1/routines/${encodeURIComponent(args.id)}`, undefined, undefined, requestOptsFromArgs({ account: args.account })),
});

const pauseRoutine = defineTool({
    name: 'gtd_pause_routine',
    description:
        'Composite gesture: trashes future open items generated by this routine and flips active=false. ' +
        'For calendar routines, the GCal master event is capped with UNTIL (not deleted) downstream.',
    inputSchema: { id: idSchema, account: accountSchema },
    handler: async (args, api) =>
        api.request('POST', `/v1/routines/${encodeURIComponent(args.id)}/pause`, {}, undefined, requestOptsFromArgs({ account: args.account })),
});

const resumeRoutine = defineTool({
    name: 'gtd_resume_routine',
    description: 'Composite gesture: flips active=true and stamps startDate=tomorrow so a fresh series begins.',
    inputSchema: { id: idSchema, account: accountSchema },
    handler: async (args, api) =>
        api.request('POST', `/v1/routines/${encodeURIComponent(args.id)}/resume`, {}, undefined, requestOptsFromArgs({ account: args.account })),
});

const splitRoutine = defineTool({
    name: 'gtd_split_routine',
    description:
        'Composite gesture: cap the head routine with UNTIL=splitDate, delete its future calendar items, and ' +
        'create a new tail routine carrying optional edits. Useful for "this and following occurrences" changes. ' +
        'tailEdits accepts: title, rrule, recurrenceAnchor, routineType (switch nextAction↔calendar going forward), ' +
        'template, calendarItemTemplate, startDate, active.',
    inputSchema: {
        id: idSchema,
        splitDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe('YYYY-MM-DD. The first day the new tail routine takes effect.'),
        // tailEdits mirror SplitParams.tailEdits in api-server/src/lib/routineComposites.ts.
        // Keep this in sync — the route layer passes the value through opaquely.
        tailEdits: z
            .object({
                title: z.string().optional(),
                rrule: z.string().optional(),
                recurrenceAnchor: recurrenceAnchorSchema,
                routineType: z.enum(['nextAction', 'calendar']).optional(),
                template: routineTemplateSchema.optional(),
                calendarItemTemplate: calendarItemTemplateSchema.optional(),
                startDate: z
                    .string()
                    .regex(/^\d{4}-\d{2}-\d{2}$/)
                    .optional(),
                active: z.boolean().optional(),
            })
            .optional(),
        account: accountSchema,
    },
    handler: async ({ id, account, ...body }, api) =>
        api.request('POST', `/v1/routines/${encodeURIComponent(id)}/split`, body, undefined, requestOptsFromArgs({ account })),
});

export function registerRoutineTools(server: McpServer, api: ApiClient): void {
    registerOne(server, listRoutines, api);
    registerOne(server, getRoutine, api);
    registerOne(server, createRoutine, api);
    registerOne(server, updateRoutine, api);
    registerOne(server, deleteRoutine, api);
    registerOne(server, pauseRoutine, api);
    registerOne(server, resumeRoutine, api);
    registerOne(server, splitRoutine, api);
}

export const _routineToolsForTesting = {
    listRoutines,
    getRoutine,
    createRoutine,
    updateRoutine,
    deleteRoutine,
    pauseRoutine,
    resumeRoutine,
    splitRoutine,
};
