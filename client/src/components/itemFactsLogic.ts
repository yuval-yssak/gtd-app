/**
 * An item's metadata as display-ready label/value facts — the read-only face of the per-status
 * forms. Shared by the done item's "Before it was done" panel and the weekly review's details
 * summary so both word every field the same way. Render-free so it unit-tests under node.
 */
import dayjs from 'dayjs';
import { formatAllDayDate, fromGCalExclusive } from '../lib/allDayDate';
import { formatDisplayDate } from '../lib/displayDate';
import type { StoredItem, StoredPerson, StoredWorkContext } from '../types/MyDB';
import { isMultiDayAllDay } from './calendarRouteSort';

/** Name maps built ONCE per render pass — a list resolves every mounted row through them. */
export interface ItemFactLookups {
    personNameById: ReadonlyMap<string, string>;
    contextNameById: ReadonlyMap<string, string>;
}

export function buildItemFactLookups(people: ReadonlyArray<StoredPerson>, workContexts: ReadonlyArray<StoredWorkContext>): ItemFactLookups {
    return {
        personNameById: new Map(people.map((person) => [person._id, person.name])),
        contextNameById: new Map(workContexts.map((context) => [context._id, context.name])),
    };
}

export interface ItemFact {
    label: string;
    value: string;
}

export type FactKey = 'when' | 'location' | 'guests' | 'waitingFor' | 'contexts' | 'people' | 'energy' | 'time' | 'urgent' | 'expectedBy' | 'hiddenUntil';

/** The facts named by `keys`, in that order; a key whose field is empty yields nothing. */
export function itemFacts(keys: ReadonlyArray<FactKey>, item: StoredItem, lookups: ItemFactLookups): ItemFact[] {
    return keys.flatMap((key) => {
        const value = factValue(key, item, lookups);
        return value ? [{ label: FACT_LABELS[key], value }] : [];
    });
}

const FACT_LABELS: Record<FactKey, string> = {
    when: 'When',
    location: 'Location',
    guests: 'Guests',
    waitingFor: 'Waiting for',
    contexts: 'Contexts',
    people: 'People',
    energy: 'Energy',
    time: 'Time',
    urgent: 'Priority',
    expectedBy: 'Expected by',
    hiddenUntil: 'Hidden until',
};

function factValue(key: FactKey, item: StoredItem, lookups: ItemFactLookups): string {
    switch (key) {
        case 'when':
            return formatEventWhen(item);
        case 'location':
            return item.location ?? '';
        case 'guests':
            return formatGuestCount(item.attendees?.length ?? 0);
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
        case 'urgent':
            return item.urgent ? 'Urgent' : '';
        case 'expectedBy':
            return formatDay(item.expectedBy);
        case 'hiddenUntil':
            return formatDay(item.ignoreBefore);
    }
}

function formatGuestCount(count: number): string {
    if (count === 0) return '';
    return count === 1 ? '1 guest' : `${count} guests`;
}

/** Names in reference order; a dangling id (the person or context was deleted) is left out, never shown raw. */
function namesOf(ids: ReadonlyArray<string>, nameById: ReadonlyMap<string, string>) {
    return ids.flatMap((id) => nameById.get(id) ?? []).join(', ');
}

const formatDay = (date: string | undefined) => (date ? formatDisplayDate(dayjs(date), 'MMM D') : '');

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
    return `${formatDisplayDate(start, 'ddd, MMM D')} · ${start.format('h:mm a')}${endPart}`;
}

function formatAllDayWhen(timeStart: string, multiDayExclusiveEnd: string | undefined): string {
    const startLabel = formatAllDayDate(timeStart, 'ddd, MMM D');
    const endLabel = multiDayExclusiveEnd ? ` – ${formatAllDayDate(fromGCalExclusive(multiDayExclusiveEnd), 'ddd, MMM D')}` : '';
    return `${startLabel}${endLabel} · all day`;
}
