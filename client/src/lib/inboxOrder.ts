import type { StoredItem } from '../types/MyDB';
import { compareByRank } from './compareNextActions';
import { filterItemsByQuery } from './itemSearch';

/**
 * The inbox as the user sees it: inbox items only, in their manual order (`rank` — a capture is
 * minted at the top), narrowed to the in-page search. The inbox list and the Process Inbox run share
 * it, so the run walks exactly the items — and the count — the inbox showed ("process what I searched for").
 */
export function inboxItemsInOrder(items: readonly StoredItem[], query: string): StoredItem[] {
    return [
        ...filterItemsByQuery(
            items.filter((item) => item.status === 'inbox'),
            query,
        ),
    ].sort(compareByRank);
}
