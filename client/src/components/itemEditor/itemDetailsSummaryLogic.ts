import type { StoredAccount, StoredItem } from '../../types/MyDB';
import { type FactKey, type ItemFact, type ItemFactLookups, itemFacts } from '../itemFactsLogic';
import type { EditorPresentation } from './briefSectionLogic';

type ItemStatus = StoredItem['status'];

/**
 * Per status, the fields its detail form edits — in the form's own order, so the summary and the
 * form read alike. Inbox, done and trash are absent: inbox and trash have no detail form, and a
 * done item already shows its read-only "Before it was done" panel.
 */
const SUMMARY_FACTS: Partial<Record<ItemStatus, ReadonlyArray<FactKey>>> = {
    nextAction: ['contexts', 'people', 'energy', 'time', 'urgent', 'expectedBy', 'hiddenUntil'],
    // No location: the read-only event links beside the summary already show it.
    calendar: ['when', 'guests'],
    waitingFor: ['waitingFor', 'expectedBy', 'hiddenUntil'],
    somedayMaybe: ['expectedBy', 'hiddenUntil'],
};

/** The item's filled detail fields as read-only facts; empty fields are left out. */
export function itemDetailFacts(item: StoredItem, lookups: ItemFactLookups): ItemFact[] {
    const keys = SUMMARY_FACTS[item.status];
    return keys ? itemFacts(keys, item, lookups) : [];
}

/** What decides between the read-only summary and the detail form on one editor mount. */
export interface DetailsViewState {
    /** The user pressed "Edit details" on this mount. */
    isExpanded: boolean;
    /** The status chip currently selected (may differ from the saved status while unsaved). */
    selectedStatus: ItemStatus | 'routine';
    savedStatus: ItemStatus;
}

/**
 * Review cards are mostly scanned, so they summarise the saved details and open the form only on
 * request. Picking another status opens it straight away: a status the item does not have yet has
 * nothing saved to summarise, and its form is exactly what the user now needs.
 */
export function isDetailsSummaryShown(presentation: EditorPresentation, view: DetailsViewState): boolean {
    if (presentation !== 'review' || view.isExpanded || view.selectedStatus !== view.savedStatus) {
        return false;
    }
    return SUMMARY_FACTS[view.savedStatus] !== undefined;
}

/**
 * The owning account as a fact, for a multi-account device only — the summary folds away the form's
 * account picker, and without this line the reviewer could no longer tell whose item it is.
 */
export function ownerAccountFacts(accounts: ReadonlyArray<StoredAccount>, ownerUserId: string): ItemFact[] {
    if (accounts.length < 2) {
        return [];
    }
    const owner = accounts.find((account) => account.id === ownerUserId);
    return owner ? [{ label: 'Account', value: owner.email }] : [];
}
