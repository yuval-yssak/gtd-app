import type { IDBPDatabase } from 'idb';
import type { MyDB } from './MyDB';

export interface RouterContext {
    db: IDBPDatabase<MyDB>;
}
