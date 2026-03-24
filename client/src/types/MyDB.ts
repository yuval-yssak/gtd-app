import type { DBSchema } from 'idb';

export type OAuthProvider = 'google' | 'github';

export interface StoredAccount {
    id: string; // Better Auth user ID (UUID)
    email: string;
    name: string;
    image: string | null; // null (not undefined) to satisfy exactOptionalPropertyTypes
    provider: OAuthProvider; // last provider used to sign in to this account
    addedAt: number; // unix ms — used to preserve order in the switcher
}

export interface StoredItem {
    _id: string; // client-generated UUID — doubles as the MongoDB _id
    userId: string; // Better Auth user ID — mirrors ItemInterface.user
    status: 'inbox' | 'nextAction' | 'calendar' | 'waitingFor' | 'done' | 'trash';
    title: string;
    createdTs: string;
    workContexts?: string[];
    people?: string[];
    expectedBy?: string;
    timeStart?: string;
    timeEnd?: string;
    energy?: 'low' | 'medium' | 'high';
    time?: number; // minutes
    focus?: boolean;
    urgent?: boolean;
}

export type SyncOpType = 'create' | 'update' | 'delete';

export interface SyncOperation {
    id?: number; // auto-increment — omitted before insertion
    type: SyncOpType;
    itemId: string;
    queuedAt: string;
}

export interface MyDB extends DBSchema {
    // All known accounts across all sign-ins
    accounts: {
        key: string; // StoredAccount.id
        value: StoredAccount;
        indexes: { email: string };
    };
    // Single-entry store: which account is currently active (matches the live Better Auth session)
    activeAccount: {
        key: 'active';
        value: { userId: string };
    };
    // All GTD items for all accounts on this device
    items: {
        key: string; // StoredItem._id
        value: StoredItem;
        indexes: { userId: string };
    };
    // Pending mutations to replay against the server when connectivity is restored
    syncOperations: {
        key: number; // auto-increment
        value: SyncOperation;
    };
}
