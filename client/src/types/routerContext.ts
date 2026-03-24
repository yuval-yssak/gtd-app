import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredItem } from './MyDB';

export interface RouterContext {
    db: IDBPDatabase<MyDB>;
    items: StoredItem[];
    setItems: React.Dispatch<React.SetStateAction<StoredItem[]>>;
}
