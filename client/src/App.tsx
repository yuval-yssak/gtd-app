import { IDBPDatabase } from "idb";
import CircularProgress from "@mui/material/CircularProgress";
import { x } from "./loaders/axios";
import { createRouter, RouterProvider } from "@tanstack/react-router";

// Import the generated route tree
import { routeTree } from "./routeTree.gen";
// import { isAxiosError } from "axios";
import { useEffect, useState, useSyncExternalStore } from "react";
// import { useOnlineStatus } from "./hooks/useOnlineStatus";
import { MyDB } from "./types/MyDB";
import { AuthContext } from "./types/routerContextTypes";

// Create a new router instance
const router = createRouter({
    //
    routeTree,
    context: { auth: undefined!, db: undefined!, items:[] },
    defaultPreloadStaleTime: 0, // manage preload cache externally to @tanstack/react-router
});

// Register the router instance for type safety
declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}

async function checkAuth() {
    await new Promise((r) => setTimeout(r, 500));
    try {
        return await x.get<{ contents: { id: string; email: string }[] }>("/auth/check");
    } catch (e) {
        console.log(e);
        throw e;
    }
}

/**
 * User is logged in if it is so in IndexedDB first.
 * When online (and server running), check server for logged in status.
 *
 * User can log out, then the cookie is removed and the IndexedDB login state is removed.
 *
 * When logged in, the client will save the IndexedDB state.
 */
function useAuth(db: IDBPDatabase<MyDB>): AuthContext | "pending" {
    const [pending, setPending] = useState(true);
    const [localLoggedIn, setLocalLoggedIn] = useState<AuthContext>();
    useEffect(() => {
        db.getAll("localLoggedIn").then((result) => {
            console.log({ result });
            if (result?.[0]) {
                const a = result[0];
                setLocalLoggedIn({ ...a, activeEmail: a.loggedInUsers.find((c) => c.id === a.activeUser)!.email });
            }
            setPending(false);
        });
    }, [db]);

    useEffect(() => {
        checkAuth().then(async (authFromServer) => {
            console.log({ authFromServer });
            const { contents } = authFromServer.data;
            if (!contents.length) {
                return;
            }
            setLocalLoggedIn({ activeUser: contents[0].id, loggedInUsers: contents, activeEmail: contents.find((c) => c.id === contents[0].id)!.email });
            await db.put("localLoggedIn", { activeUser: contents[0].id, loggedInUsers: contents }, "login");
        });
    }, [db]);

    if (localLoggedIn) {
        return localLoggedIn;
    }
    if (pending) {
        return "pending";
    }
    return { loggedInUsers: [], activeUser: "", activeEmail: "" };
}


function subscribeItems(callback:()=>string) {
    navigator.serviceWorker.addEventListener('message', (event) =>{
        
    })
}
function useItems() {
    // ask sw get get items
    // return them
    
    // todo: move to a const
    // todo: has to happen once
    navigator.serviceWorker.controller?.postMessage({ type: 'GET_ITEMS' });

    return useSyncExternalStore(subscribeItems, ()=>)


    
}



// function subscribe(callback: () => void) {
//     window.addEventListener("online", callback);
//     window.addEventListener("offline", callback);
  
//     return () => {
//       window.removeEventListener("online", callback);
//       window.removeEventListener("offline", callback);
//     };
//   }
  
  export function useOnlineStatus() {
    return useSyncExternalStore(subscribe, () => navigator.onLine);
  }
  
export function App({ db }: { db: IDBPDatabase<MyDB> }) {
    const auth = useAuth(db);
    const items = useItems();

    if (auth === "pending") {
        return <CircularProgress />;
    }

    return (
        <>
            <RouterProvider router={router} context={{ auth, db, items }} />
        </>
    );
}
