import type { DBSchema } from 'idb'

export type OAuthProvider = 'google' | 'github'

export interface StoredAccount {
    id: string // Better Auth user ID (UUID)
    email: string
    name: string
    image: string | null // null (not undefined) to satisfy exactOptionalPropertyTypes
    provider: OAuthProvider // last provider used to sign in to this account
    addedAt: number // unix ms — used to preserve order in the switcher
}

export interface MyDB extends DBSchema {
    // All known accounts across all sign-ins
    accounts: {
        key: string // StoredAccount.id
        value: StoredAccount
        indexes: { email: string }
    }
    // Single-entry store: which account is currently active (matches the live Better Auth session)
    activeAccount: {
        key: 'active'
        value: { userId: string }
    }
}
