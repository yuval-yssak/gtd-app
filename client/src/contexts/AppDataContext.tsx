import { createContext, useContext } from 'react';
import type { StoredAccount, StoredItem, StoredPerson, StoredWorkContext } from '../types/MyDB';

interface AppData {
    account: StoredAccount | null;
    items: StoredItem[];
    workContexts: StoredWorkContext[];
    people: StoredPerson[];
    refreshItems: () => Promise<void>;
    refreshWorkContexts: () => Promise<void>;
    refreshPeople: () => Promise<void>;
}

// Stub default — AuthenticatedLayout always provides real values before any route renders.
// Required by createContext but never reached in practice.
const noop = () => Promise.resolve();

export const AppDataContext = createContext<AppData>({
    account: null,
    items: [],
    workContexts: [],
    people: [],
    refreshItems: noop,
    refreshWorkContexts: noop,
    refreshPeople: noop,
});

export function useAppData(): AppData {
    return useContext(AppDataContext);
}
