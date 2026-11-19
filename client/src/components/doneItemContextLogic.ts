/**
 * What a done item WAS before it was completed — its open status and the fields that mattered
 * there (a calendar event's start/end, whom a waiting-for waited on, a next action's contexts).
 * Render-free so it unit-tests under vitest's node environment.
 */
import { STATUS_LABELS } from '../lib/itemSearch';
import { hasAtLeastOne } from '../lib/typeUtils';
import type { OpenItemStatus, StoredItem } from '../types/MyDB';
import { type FactKey, type ItemFact, type ItemFactLookups, itemFacts } from './itemFactsLogic';

export interface DoneItemContext {
    /** Null when neither the record nor the leftover fields can tell the prior status apart. */
    status: OpenItemStatus | null;
    statusLabel: string | null;
    /** True when `status` was deduced from leftover fields (items completed before it was recorded); also true when `status` is null — nothing was recorded. */
    isInferred: boolean;
    /** Most prominent first. */
    facts: ItemFact[];
}

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
export function doneItemContext(item: StoredItem, lookups: ItemFactLookups): DoneItemContext | null {
    if (item.status !== 'done') {
        return null;
    }
    const prior = priorStatusOf(item);
    const facts = itemFacts(FACTS_BY_STATUS[prior?.status ?? 'unknown'], item, lookups);
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
