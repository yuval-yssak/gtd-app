import type { EnergyLevel, ItemStatus } from '../../types/entities.js';

/**
 * The set of item fields the clarify agent is allowed to propose changing. Deliberately scoped to
 * the GTD-clarify fields (the status×field matrix for `nextAction`/`waitingFor`/`calendar`): no
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
 * A proposed side-effect the user can apply, edit, or skip. `kind` discriminates how the apply
 * handler turns it into an operation; `preview` is human-readable; `executeToken` is minted by the
 * server AFTER the loop (the model never produces it — see executeToken.ts).
 */
export interface ProposedSideEffect {
    kind: 'itemPatch' | 'calendarSideEffect';
    preview: string;
    executeToken?: string; // filled in by the route handler post-loop; absent in step (b)
}

export interface ClarifyProposal {
    summary: string;
    proposedItemPatch?: ProposedItemPatch;
    proposedSideEffects: ProposedSideEffect[];
}

/**
 * The json_schema passed via `output_config.format` so the model's final turn is a valid
 * `ClarifyProposal`. `additionalProperties: false` everywhere (required by the structured-output
 * feature) keeps the model from inventing fields the apply handler doesn't understand.
 */
export const CLARIFY_PROPOSAL_SCHEMA = {
    type: 'object',
    properties: {
        summary: { type: 'string' },
        proposedItemPatch: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                notes: { type: 'string' },
                status: { type: 'string', enum: ['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe', 'done', 'trash'] },
                workContextIds: { type: 'array', items: { type: 'string' } },
                peopleIds: { type: 'array', items: { type: 'string' } },
                waitingForPersonId: { type: 'string' },
                energy: { type: 'string', enum: ['low', 'medium', 'high'] },
                time: { type: 'integer' },
                focus: { type: 'boolean' },
                urgent: { type: 'boolean' },
                expectedBy: { type: 'string' },
                ignoreBefore: { type: 'string' },
                timeStart: { type: 'string' },
                timeEnd: { type: 'string' },
                allDay: { type: 'boolean' },
            },
            additionalProperties: false,
        },
        proposedSideEffects: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: ['itemPatch', 'calendarSideEffect'] },
                    preview: { type: 'string' },
                },
                required: ['kind', 'preview'],
                additionalProperties: false,
            },
        },
    },
    required: ['summary', 'proposedSideEffects'],
    additionalProperties: false,
} as const;
