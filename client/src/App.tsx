import { createRouter, RouterProvider } from '@tanstack/react-router'
import type { IDBPDatabase } from 'idb'
import type { MyDB } from './types/MyDB'
import { routeTree } from './routeTree.gen'

const router = createRouter({
    routeTree,
    context: {
        // db is populated at runtime in main.tsx before the router is created
        db: undefined!,
    },
})

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router
    }
}

interface Props {
    db: IDBPDatabase<MyDB>
}

export default function App({ db }: Props) {
    return <RouterProvider router={router} context={{ db }} />
}
