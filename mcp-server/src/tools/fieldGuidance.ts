/**
 * Field-completeness guidance for item writes. The GTD method only works when a next action
 * carries the metadata the Do phase filters on (energy, duration, work context), a waiting-for
 * item says when the delegated outcome is expected, and a calendar event names its venue. An
 * LLM driving `gtd_update_item` tends to set `status` and stop, so after every update the MCP
 * inspects the returned item and, when any of those fields is still empty, stamps a
 * `fieldGuidance` block next to the entity: the list of missing fields plus a hint telling the
 * model how to fill each one (or to ask the user). The hint is advisory — the write already
 * succeeded — and disappears once the fields are populated, so it never nags a complete item.
 *
 * Only write tools are decorated: a read (`gtd_get_item`, `gtd_list_items`) must not tempt the
 * model into "fixing" items the user only asked to look at. `gtd_capture` lands in `inbox`,
 * which has no required metadata, and complete/trash leave the active statuses, so in practice
 * `gtd_update_item` is the one tool whose response can carry the block.
 *
 * Every field inspected here must be one the `/v1` item projection actually returns
 * (`api-server/src/routes/v1/projections/item.ts`) — a field the allowlist drops would look
 * "missing" on every response and the nudge could never be satisfied.
 */

/**
 * Guidance text shared by the `gtd_update_item` description and the server instructions, so the
 * model learns the rule before it writes (and sends the fields with the status change) rather
 * than only after the response points out what it forgot.
 */
export const FIELD_COMPLETENESS_GUIDANCE =
    'Completeness: when you set or keep a status, send the metadata the GTD method relies on in the SAME call — ' +
    'a nextAction needs `energy`, `time` and `workContextIds`; a waitingFor needs `expectedBy`. A calendar item ' +
    'linked to Google Calendar should also name its `location`; that field is Google-owned and read-only here, so ' +
    'set it on the linked Google event instead of sending it to gtd_update_item. Infer the values from what you ' +
    'know about the task, or ask the user. If any of them is still empty after the write, the response carries ' +
    '`fieldGuidance: { missing, hint }` — the write succeeded; fill in the listed fields and update again.';

/** Tools whose item response gets inspected. Keep to writes — see the header comment. */
const GUIDED_TOOLS: ReadonlySet<string> = new Set(['gtd_update_item']);

type PublicItem = Record<string, unknown>;

interface GuidedField {
    field: string;
    isMissingOn: (item: PublicItem) => boolean;
}

interface StatusGuidance {
    /** Rules evaluated against the item; only the ones that report missing are listed. */
    fields: ReadonlyArray<GuidedField>;
    /** Decides whether this item is one the rules apply to at all (e.g. linked to Google). */
    appliesTo: (item: PublicItem) => boolean;
    hint: (item: PublicItem) => string;
}

const isUnset = (value: unknown) => value === undefined || value === null;
const lacksText = (value: unknown) => typeof value !== 'string' || value.trim() === '';
const isEmptyList = (value: unknown) => !Array.isArray(value) || value.length === 0;
const hasText = (value: unknown) => !lacksText(value);

const NEXT_ACTION_HINT =
    'A next action is only actionable in the Do phase when it carries all three: `energy` (low / medium / high), ' +
    '`time` (estimated duration in minutes) and `workContextIds` (the condition it needs — usually exactly one id ' +
    'from gtd_list_work_contexts). Fill in the missing ones from what you know about the task, or ask the user, ' +
    'then call gtd_update_item again.';

const WAITING_FOR_HINT =
    'A waiting-for item should say when the delegated outcome is expected: set `expectedBy` (YYYY-MM-DD) so the ' +
    'review can flag it as overdue. Use the date the other person committed to, or ask the user, then call ' +
    'gtd_update_item again.';

/**
 * `location` is owned by Google Calendar (read-only on the item, never writable through PATCH),
 * so the only way to set it is on the linked Google event; the calendar sync mirrors it back.
 * The rule therefore applies only once the item carries a `calendarEventId` — an item with no
 * Google Calendar connected could never satisfy it.
 */
const calendarHint = ({ calendarEventId }: PublicItem) =>
    'A calendar event is easier to act on when it names where it happens. `location` is owned by Google Calendar ' +
    `and read-only here: if the venue, address or meeting room is known, set it on the linked Google Calendar event ` +
    `(calendarEventId ${String(calendarEventId)}) and the sync mirrors it onto this item. Skip this when the event ` +
    'genuinely has no place (a call, a reminder).';

/**
 * Per-status guidance. `time: 0` is a deliberate "no time at all" estimate, so only an unset
 * value counts as missing; an empty `workContextIds` array is as unhelpful as none at all.
 */
const GUIDANCE_BY_STATUS: Partial<Record<'nextAction' | 'waitingFor' | 'calendar', StatusGuidance>> = {
    nextAction: {
        fields: [
            { field: 'energy', isMissingOn: ({ energy }) => isUnset(energy) },
            { field: 'time', isMissingOn: ({ time }) => isUnset(time) },
            { field: 'workContextIds', isMissingOn: ({ workContextIds }) => isEmptyList(workContextIds) },
        ],
        appliesTo: () => true,
        hint: () => NEXT_ACTION_HINT,
    },
    waitingFor: {
        fields: [{ field: 'expectedBy', isMissingOn: ({ expectedBy }) => lacksText(expectedBy) }],
        appliesTo: () => true,
        hint: () => WAITING_FOR_HINT,
    },
    calendar: {
        fields: [{ field: 'location', isMissingOn: ({ location }) => lacksText(location) }],
        appliesTo: ({ calendarEventId }) => hasText(calendarEventId),
        hint: calendarHint,
    },
};

const isGuidedStatus = (status: unknown): status is keyof typeof GUIDANCE_BY_STATUS => typeof status === 'string' && Object.hasOwn(GUIDANCE_BY_STATUS, status);

export interface FieldGuidance {
    missing: string[];
    hint: string;
}

/**
 * Returns the guidance block for an item, or `null` when the item's status has no guided fields,
 * the rules do not apply to it, or every guided field is populated.
 */
export function fieldGuidanceFor(item: PublicItem): FieldGuidance | null {
    const { status } = item;
    const guidance = isGuidedStatus(status) ? GUIDANCE_BY_STATUS[status] : undefined;
    if (!guidance?.appliesTo(item)) {
        return null;
    }
    const missing = guidance.fields.filter((rule) => rule.isMissingOn(item)).map((rule) => rule.field);
    if (missing.length === 0) {
        return null;
    }
    return { missing, hint: `Missing: ${missing.join(', ')}. ${guidance.hint(item)}` };
}

/**
 * Stamps `fieldGuidance` onto the item returned by a guided write tool. Any other tool, or a
 * payload that is not an item record, passes through untouched.
 */
export function decorateWithFieldGuidance(toolName: string, result: unknown): unknown {
    if (!GUIDED_TOOLS.has(toolName) || !isRecord(result)) {
        return result;
    }
    const guidance = fieldGuidanceFor(result);
    return guidance ? { ...result, fieldGuidance: guidance } : result;
}

function isRecord(value: unknown): value is PublicItem {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
