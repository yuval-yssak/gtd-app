import type { Decorator } from '@storybook/react';
import { fn } from 'storybook/test';
import { type AppData, AppDataContext } from '../contexts/AppDataProvider';
import { PendingReassignProvider } from '../contexts/PendingReassignProvider';
import { mockDb } from './storybookMocks';

/** An AppData context value with empty lists and no-op refreshes; stories override what they show. */
export function buildMockAppData(overrides: Partial<AppData> = {}): AppData {
    return {
        account: null,
        loggedInAccounts: [],
        loggedInUserIds: [],
        items: [],
        workContexts: [],
        people: [],
        routines: [],
        reviewInboxes: [],
        itemBriefs: [],
        allItems: [],
        allWorkContexts: [],
        allPeople: [],
        allRoutines: [],
        allReviewInboxes: [],
        allItemBriefs: [],
        refreshItems: fn().mockResolvedValue(undefined),
        refreshWorkContexts: fn().mockResolvedValue(undefined),
        refreshPeople: fn().mockResolvedValue(undefined),
        refreshRoutines: fn().mockResolvedValue(undefined),
        refreshReviewInboxes: fn().mockResolvedValue(undefined),
        refreshItemBriefs: fn().mockResolvedValue(undefined),
        refreshAccounts: fn().mockResolvedValue(undefined),
        syncAndRefresh: fn().mockResolvedValue(undefined),
        isInitialSyncing: false,
        isCalendarSyncing: false,
        // Identity passthrough in Storybook — no real session to pivot. Runs the wrapped mutation as-is.
        withActiveAccountSession: (task) => task(),
        withOwnerSession: (_userId, task) => task(),
        ...overrides,
    };
}

/**
 * The providers the item and routine editor bodies read: the app data (pickers, briefs, accounts)
 * and the pending-reassign overlay. Pair it with RouterDecorator — both bodies arm a router blocker.
 */
export function editorProvidersDecorator(overrides: Partial<AppData> = {}): Decorator {
    const appData = buildMockAppData(overrides);
    return (Story) => (
        <AppDataContext.Provider value={appData}>
            <PendingReassignProvider db={mockDb}>
                <Story />
            </PendingReassignProvider>
        </AppDataContext.Provider>
    );
}
