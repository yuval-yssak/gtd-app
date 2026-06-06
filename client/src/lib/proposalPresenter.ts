import dayjs from 'dayjs';
import type { ClarifyProposal, ProposableItemField, ProposedItemPatch, ProposedSideEffect } from '../api/assistApi';
import type { EnergyLevel, StoredPerson, StoredWorkContext } from '../types/MyDB';

/**
 * Pure helpers that turn a raw `ProposedItemPatch` into human-readable review rows, and pick the one
 * appliable side-effect. Kept React-free so the rendering rules are unit-tested directly (the client
 * test env is `node`/no-DOM — see the *Logic.ts convention).
 */

type ItemStatus = NonNullable<ProposedItemPatch['status']>;

/** Human labels for each proposable field. Covers every entry in the server's PROPOSABLE_ITEM_FIELDS. */
const FIELD_LABELS: Record<ProposableItemField, string> = {
    title: 'Title',
    notes: 'Notes',
    status: 'Status',
    workContextIds: 'Contexts',
    peopleIds: 'People',
    waitingForPersonId: 'Waiting on',
    energy: 'Energy',
    time: 'Time',
    focus: 'Focus',
    urgent: 'Urgent',
    expectedBy: 'Expected by',
    ignoreBefore: 'Hidden until',
    timeStart: 'Starts',
    timeEnd: 'Ends',
    allDay: 'All day',
};

const STATUS_LABELS: Record<ItemStatus, string> = {
    inbox: 'Inbox',
    nextAction: 'Next Action',
    calendar: 'Calendar',
    waitingFor: 'Waiting For',
    somedayMaybe: 'Someday / Maybe',
    done: 'Done',
    trash: 'Trash',
};

// Mirrors the canonical energy labels in next-actions.tsx (kept here so the presenter stays
// route-independent). A new energy level would surface a type error here and there.
const ENERGY_LABELS: Record<EnergyLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' };

export interface PresentedField {
    field: ProposableItemField;
    label: string;
    display: string;
}

interface ReferenceData {
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
}

/** Resolves a list of ids to a comma-joined name string, falling back to the raw id for unknowns. */
function namesFor(ids: string[], byId: Map<string, string>): string {
    return ids.map((id) => byId.get(id) ?? id).join(', ');
}

const indexByName = (rows: Array<{ _id: string; name: string }>) => new Map(rows.map((r) => [r._id, r.name]));

/** Formats a single proposed field value for display, resolving ids/enums/units against reference data. */
function displayValue(field: ProposableItemField, patch: ProposedItemPatch, ref: ReferenceData): string {
    const people = indexByName(ref.people);
    const contexts = indexByName(ref.workContexts);
    switch (field) {
        case 'status':
            return patch.status ? STATUS_LABELS[patch.status] : '';
        case 'energy':
            return patch.energy ? ENERGY_LABELS[patch.energy] : '';
        case 'workContextIds':
            return namesFor(patch.workContextIds ?? [], contexts);
        case 'peopleIds':
            return namesFor(patch.peopleIds ?? [], people);
        case 'waitingForPersonId':
            return patch.waitingForPersonId ? (people.get(patch.waitingForPersonId) ?? patch.waitingForPersonId) : '';
        case 'time':
            return patch.time === undefined ? '' : `${patch.time} min`;
        case 'focus':
        case 'urgent':
        case 'allDay':
            return patch[field] ? 'Yes' : 'No';
        case 'expectedBy':
        case 'ignoreBefore':
        case 'timeStart':
        case 'timeEnd':
            return patch[field] ? dayjs(patch[field]).format('MMM D, YYYY h:mm A') : '';
        default:
            return String(patch[field] ?? '');
    }
}

/** Turns a patch into one display row per changed field, in the proposable-field order. */
export function presentPatch(patch: ProposedItemPatch, ref: ReferenceData): PresentedField[] {
    return (Object.keys(FIELD_LABELS) as ProposableItemField[])
        .filter((field) => patch[field] !== undefined)
        .map((field) => ({ field, label: FIELD_LABELS[field], display: displayValue(field, patch, ref) }));
}

/** The first side-effect carrying an executeToken — the only one the apply endpoint can redeem in v1. */
export function appliableSideEffect(proposal: ClarifyProposal): ProposedSideEffect | undefined {
    return proposal.proposedSideEffects.find((s) => s.executeToken !== undefined);
}
