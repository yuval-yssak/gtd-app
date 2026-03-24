import { createRouter, RouterProvider } from '@tanstack/react-router';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { routeTree } from './routeTree.gen';
import type { MyDB, StoredItem } from './types/MyDB';

// Router is created once at module level to avoid recreation on every render.
// context values are stubs — the real values are injected via RouterProvider below.
const router = createRouter({
    routeTree,
    context: {
        // Stubs satisfy the type shape; real values are injected via RouterProvider on every render
        db: null as unknown as IDBPDatabase<MyDB>,
        items: [] as StoredItem[],
        setItems: () => {},
    },
});

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router;
    }
}

interface Props {
    db: IDBPDatabase<MyDB>;
}

export default function App({ db }: Props) {
    const [items, setItems] = useState<StoredItem[]>([]);

    return <RouterProvider router={router} context={{ db, items, setItems }} />;
}
