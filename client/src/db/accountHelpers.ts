import type { IDBPDatabase } from 'idb'
import type { MyDB, StoredAccount } from '../types/MyDB'

export async function upsertAccount(account: StoredAccount, db: IDBPDatabase<MyDB>): Promise<void> {
    await db.put('accounts', account)
}

export async function setActiveAccount(userId: string, db: IDBPDatabase<MyDB>): Promise<void> {
    await db.put('activeAccount', { userId }, 'active')
}

export async function getActiveAccount(db: IDBPDatabase<MyDB>): Promise<StoredAccount | undefined> {
    const active = await db.get('activeAccount', 'active')
    if (!active) return undefined
    return db.get('accounts', active.userId)
}

export async function getAllAccounts(db: IDBPDatabase<MyDB>): Promise<StoredAccount[]> {
    const all = await db.getAll('accounts')
    // Sort oldest-added first so order is stable across reads
    return all.sort((a, b) => a.addedAt - b.addedAt)
}

export async function removeAccount(userId: string, db: IDBPDatabase<MyDB>): Promise<void> {
    await db.delete('accounts', userId)
    const active = await db.get('activeAccount', 'active')
    if (active?.userId === userId) {
        await db.delete('activeAccount', 'active')
    }
}

export async function clearAllAccounts(db: IDBPDatabase<MyDB>): Promise<void> {
    await db.clear('accounts')
    await db.delete('activeAccount', 'active')
}

