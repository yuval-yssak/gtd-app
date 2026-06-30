import type { EnergyLevel, ItemStatus } from '../../types/entities.js';

/**
 * The set of item fields the clarify agent is allowed to propose changing. Deliberately scoped to
 * the GTD-clarify fields (the status×field matrix for `nextAction`/`waitingFor`/`calendar`/`somedayMaybe`): no
 * GCal-owned fields (`organizer`, `attendees`, `meetingLink`, …), no sync-internal anchors
 * (`lastPushedToGCalTs`, `contentHash`, …), and no ownership/identity fields (`_id`, `user`,
 * `createdTs`). The apply handler re-validates that every submitted patch field is in this set.
 */
export const PROPOSABLE_ITEM_FIELDS = [
    'title',
    'notes',
    'status',
    'workContextIds',
    'peopleIds',
    'waitingForPersonId',
    'energy',
    'time',
    'focus',
    'urgent',
    'expectedBy',
    'ignoreBefore',
    // Calendar fields — let the agent clarify an inbox item into a calendar entry. The write still
    // goes through the op-log, so GCal pushback creates/updates the event (no direct provider write).
    // All three are status-specific (calendar-only) and matrix-gated by the op validator: proposing
    // any of them without a status:calendar move will 400 at apply, so the agent must emit them only
    // alongside `status: 'calendar'` (see the system prompt's calendar guidance).
    'timeStart',
    'timeEnd',
    'allDay',
] as const;

export type ProposableItemField = (typeof PROPOSABLE_ITEM_FIELDS)[number];

/** A proposed change to the clarified item. All fields optional — the model proposes only what it changes. */
export interface ProposedItemPatch {
    title?: string;
    notes?: string;
    status?: ItemStatus;
    workContextIds?: string[];
    peopleIds?: string[];
    waitingForPersonId?: string;
    energy?: EnergyLevel;
    time?: number;
    focus?: boolean;
    urgent?: boolean;
    expectedBy?: string;
    ignoreBefore?: string;
    timeStart?: string;
    timeEnd?: string;
    allDay?: boolean;
}

/**
 * A proposed side-effect the user can apply, edit, or skip. `preview` is human-readable;
 * `executeToken` is minted by the server AFTER the loop (the model never produces it — see
 * executeToken.ts). Today the only kind is `itemPatch` — a calendar entry is just an item patch
 * with `status: 'calendar'` + times, so GCal pushback creates the event with no separate kind.
 */
export interface ProposedSideEffect {
    kind: 'itemPatch';
    preview: string;
    executeToken?: string; // filled in by the route handler post-loop
}

export interface ClarifyProposal {
    summary: string;
    proposedItemPatch?: ProposedItemPatch;
    proposedSideEffects: ProposedSideEffect[];
}

/**
 * `T | null` in a structured-output schema. The Anthropic structured-output validator (strict
 * json_schema) requires EVERY property listed under `properties` to also appear in `required` — it
 * has no notion of an "optional" property, and a schema that leaves properties out of `required` is
 * rejected with `invalid_request_error: "Schema is too complex."`. Optionality is therefore expressed
 * by making the field required but its value nullable. We use `anyOf: [realType, {type:'null'}]`
 * rather than the JSON-Schema `type: ['string','null']` shorthand because the latter is rejected when
 * the node also carries an `enum` (the enum members don't match the multi-type declaration). The model
 * emits `null` for any field it is not changing; `extractProposal` (agentLoop.ts) strips those nulls
 * so the rest of the apply pipeline still sees a patch of only the changed fields.
 */
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

/**
 * The json_schema passed via `output_config.format` so the model's final turn is a valid
 * `ClarifyProposal`. `additionalProperties: false` everywhere (required by the structured-output
 * feature) keeps the model from inventing fields the apply handler doesn't understand, and every
 * property is `required` with optional ones made `nullable()` per the validator contract above.
 */
export const CLARIFY_PROPOSAL_SCHEMA = {
    type: 'object',
    properties: {
        summary: { type: 'string' },
        proposedItemPatch: nullable({
            type: 'object',
            properties: {
                title: nullable({ type: 'string' }),
                notes: nullable({ type: 'string' }),
                status: nullable({ type: 'string', enum: ['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe', 'done', 'trash'] }),
                workContextIds: nullable({ type: 'array', items: { type: 'string' } }),
                peopleIds: nullable({ type: 'array', items: { type: 'string' } }),
                waitingForPersonId: nullable({ type: 'string' }),
                energy: nullable({ type: 'string', enum: ['low', 'medium', 'high'] }),
                time: nullable({ type: 'integer' }),
                focus: nullable({ type: 'boolean' }),
                urgent: nullable({ type: 'boolean' }),
                expectedBy: nullable({ type: 'string' }),
                ignoreBefore: nullable({ type: 'string' }),
                timeStart: nullable({ type: 'string' }),
                timeEnd: nullable({ type: 'string' }),
                allDay: nullable({ type: 'boolean' }),
            },
            required: [...PROPOSABLE_ITEM_FIELDS],
            additionalProperties: false,
        }),
        proposedSideEffects: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: ['itemPatch'] },
                    preview: { type: 'string' },
                },
                required: ['kind', 'preview'],
                additionalProperties: false,
            },
        },
    },
    required: ['summary', 'proposedItemPatch', 'proposedSideEffects'],
    additionalProperties: false,
} as const;
