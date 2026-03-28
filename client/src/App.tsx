import { createRouter, RouterProvider } from '@tanstack/react-router';
import type { IDBPDatabase } from 'idb';
import { routeTree } from './routeTree.gen';
import type { MyDB } from './types/MyDB';

// Router is created once at module level to avoid recreation on every render.
// The context stub is replaced with the real db on every render via RouterProvider.
const router = createRouter({
    routeTree,
    context: {
        // Stub satisfies the type shape; real value is injected via RouterProvider on every render
        db: null as unknown as IDBPDatabase<MyDB>,
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
    return <RouterProvider router={router} context={{ db }} />;
}
