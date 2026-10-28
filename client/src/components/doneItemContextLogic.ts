/**
 * What a done item WAS before it was completed — its open status and the fields that mattered
 * there (a calendar event's start/end, whom a waiting-for waited on, a next action's contexts).
 * Render-free so it unit-tests under vitest's node environment.
 */
import dayjs from 'dayjs';
import { formatAllDayDate, fromGCalExclusive } from '../lib/allDayDate';
import { STATUS_LABELS } from '../lib/itemSearch';
import { hasAtLeastOne } from '../lib/typeUtils';
import type { OpenItemStatus, StoredItem, StoredPerson, StoredWorkContext } from '../types/MyDB';
import { isMultiDayAllDay } from './calendarRouteSort';

/** Name maps built ONCE per list render — the Done list resolves every mounted row through them. */
export interface DoneContextLookups {
    personNameById: ReadonlyMap<string, string>;
    contextNameById: ReadonlyMap<string, string>;
}

export function buildDoneContextLookups(people: ReadonlyArray<StoredPerson>, workContexts: ReadonlyArray<StoredWorkContext>): DoneContextLookups {
    return {
        personNameById: new Map(people.map((person) => [person._id, person.name])),
        contextNameById: new Map(workContexts.map((context) => [context._id, context.name])),
    };
}

export interface DoneContextFact {
    label: string;
    value: string;
}

export interface DoneItemContext {
    /** Null when neither the record nor the leftover fields can tell the prior status apart. */
    status: OpenItemStatus | null;
    statusLabel: string | null;
    /** True when `status` was deduced from leftover fields (items completed before it was recorded); also true when `status` is null — nothing was recorded. */
    isInferred: boolean;
    /** Most prominent first. */
    facts: DoneContextFact[];
}

type FactKey = 'when' | 'location' | 'waitingFor' | 'contexts' | 'people' | 'energy' | 'time' | 'expectedBy' | 'hiddenUntil';

const FACTS_BY_STATUS: Record<OpenItemStatus | 'unknown', ReadonlyArray<FactKey>> = {
    calendar: ['when', 'location', 'people', 'contexts'],
    waitingFor: ['waitingFor', 'expectedBy', 'people'],
    nextAction: ['contexts', 'people', 'energy', 'time', 'expectedBy'],
    somedayMaybe: ['expectedBy', 'hiddenUntil'],
    inbox: ['people'],
    unknown: ['when', 'waitingFor', 'contexts', 'people', 'expectedBy'],
};

const SUMMARY_FACT_COUNT = 2;

/**
 * The recorded `statusBeforeDone`, else a deduction from the fields the item kept: every move
 * between open statuses strips the fields the target does not use (`db/itemMutations.ts`), so a
 * start time can only have survived from `calendar`, a waited-on person from `waitingFor`, and
 * contexts/energy/time from `nextAction`. Inbox and Someday/Maybe leave no distinguishing trace.
 */
export function priorStatusOf(item: StoredItem): { status: OpenItemStatus; isInferred: boolean } | null {
    if (item.statusBeforeDone) {
        return { status: item.statusBeforeDone, isInferred: false };
    }
    const inferred = inferPriorStatus(item);
    return inferred ? { status: inferred, isInferred: true } : null;
}

function inferPriorStatus(item: StoredItem): OpenItemStatus | null {
    if (item.timeStart) {
        return 'calendar';
    }
    if (item.waitingForPersonId) {
        return 'waitingFor';
    }
    const hasNextActionMetadata = hasAtLeastOne(item.workContextIds ?? []) || item.energy !== undefined || item.time !== undefined;
    return hasNextActionMetadata ? 'nextAction' : null;
}

/** Null for an item that is not done, or a done item with nothing to say about its past. */
export function doneItemContext(item: StoredItem, lookups: DoneContextLookups): DoneItemContext | null {
    if (item.status !== 'done') {
        return null;
    }
    const prior = priorStatusOf(item);
    const facts = FACTS_BY_STATUS[prior?.status ?? 'unknown'].flatMap((key) => factFor(key, item, lookups) ?? []);
    if (!prior && facts.length === 0) {
        return null;
    }
    return { status: prior?.status ?? null, statusLabel: prior ? STATUS_LABELS[prior.status] : null, isInferred: prior?.isInferred ?? true, facts };
}

/** One line for a list row: "Calendar · Tue, Oct 27 · 2:00 pm – 3:00 pm · Clinic". */
export function doneContextSummary(context: DoneItemContext) {
    const prominent = context.facts.slice(0, SUMMARY_FACT_COUNT).map((fact) => fact.value);
    return [...(context.statusLabel ? [context.statusLabel] : []), ...prominent].join(' · ');
}

function factFor(key: FactKey, item: StoredItem, lookups: DoneContextLookups) {
    const value = factValue(key, item, lookups);
    return value ? { label: FACT_LABELS[key], value } : null;
}

const FACT_LABELS: Record<FactKey, string> = {
    when: 'When',
    location: 'Location',
    waitingFor: 'Waiting for',
    contexts: 'Contexts',
    people: 'People',
    energy: 'Energy',
    time: 'Time',
    expectedBy: 'Expected by',
    hiddenUntil: 'Hidden until',
};

function factValue(key: FactKey, item: StoredItem, lookups: DoneContextLookups): string {
    switch (key) {
        case 'when':
            return formatEventWhen(item);
        case 'location':
            return item.location ?? '';
        case 'waitingFor':
            return namesOf(item.waitingForPersonId ? [item.waitingForPersonId] : [], lookups.personNameById);
        case 'contexts':
            return namesOf(item.workContextIds ?? [], lookups.contextNameById);
        case 'people':
            return namesOf(item.peopleIds ?? [], lookups.personNameById);
        case 'energy':
            return item.energy ? `${item.energy.charAt(0).toUpperCase()}${item.energy.slice(1)}` : '';
        case 'time':
            return item.time !== undefined ? `${item.time} min` : '';
        case 'expectedBy':
            return formatDay(item.expectedBy);
        case 'hiddenUntil':
            return formatDay(item.ignoreBefore);
    }
}

/** Names in reference order; a dangling id (the person or context was deleted) is left out, never shown raw. */
function namesOf(ids: ReadonlyArray<string>, nameById: ReadonlyMap<string, string>) {
    return ids.flatMap((id) => nameById.get(id) ?? []).join(', ');
}

const formatDay = (date: string | undefined) => (date ? dayjs(date).format('MMM D, YYYY') : '');

/**
 * "Tue, Oct 27 · 2:00 pm – 3:30 pm", in the /calendar page's `h:mm a`. All-day dates go through the
 * naive all-day helpers (no tz shift), and `timeEnd` is GCal-EXCLUSIVE, so a multi-day range is
 * converted back to its inclusive last day or it reads one day long.
 */
function formatEventWhen(item: StoredItem): string {
    if (!item.timeStart) {
        return '';
    }
    if (item.allDay) {
        return formatAllDayWhen(item.timeStart, isMultiDayAllDay(item) ? item.timeEnd : undefined);
    }
    const start = dayjs(item.timeStart);
    const endPart = item.timeEnd ? ` – ${dayjs(item.timeEnd).format('h:mm a')}` : '';
    return `${start.format('ddd, MMM D')} · ${start.format('h:mm a')}${endPart}`;
}

function formatAllDayWhen(timeStart: string, multiDayExclusiveEnd: string | undefined): string {
    const startLabel = formatAllDayDate(timeStart, 'ddd, MMM D');
    const endLabel = multiDayExclusiveEnd ? ` – ${formatAllDayDate(fromGCalExclusive(multiDayExclusiveEnd), 'ddd, MMM D')}` : '';
    return `${startLabel}${endLabel} · all day`;
}
