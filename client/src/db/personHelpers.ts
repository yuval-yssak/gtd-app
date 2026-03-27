import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredPerson } from '../types/MyDB';

export async function getPeopleByUser(db: IDBPDatabase<MyDB>, userId: string): Promise<StoredPerson[]> {
    return db.getAllFromIndex('people', 'userId', userId);
}

export async function putPerson(db: IDBPDatabase<MyDB>, person: StoredPerson): Promise<void> {
    await db.put('people', person);
}

export async function deletePersonById(db: IDBPDatabase<MyDB>, _id: string): Promise<void> {
    await db.delete('people', _id);
}
