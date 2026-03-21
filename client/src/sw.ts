import { precacheAndRoute } from "workbox-precaching";
import { openDB } from "idb";
import { produce } from "immer";
import { MyDB } from "./types/MyDB";
import { Item } from "./types/routerContextTypes";
declare let self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

async function syncActionsWithServer() {
    try {
        const db = await openDB<MyDB>("my-first-store", 1);
        const unsyncedActions = await db.getAllFromIndex("syncOperations", "synced", 0);
        if (!unsyncedActions.length) return;

        for (const action of unsyncedActions) {
            console.log({ action });
            const synchedAction = produce(action, (draft) => {
                draft.synced = 1;
            });
            await db.put("syncOperations", synchedAction, action.uuid);
        }
    } catch (error) {
        console.error("Error syncing actions with server:", error);
    }
}

self.addEventListener("message", (event) => {
    if (event.data.type === "NEW_ACTION") {
        syncActionsWithServer();
    }
});

self.addEventListener("message", (event) => {
    if (event.data && event.data.type === "GET_ITEMS") {
        // Respond with mock data
        const items: Item[] = [{ createdTs: "asdf", status: "calendar", title: "a", user: "123" }];
        event.source?.postMessage({ type: "ITEMS_RESPONSE", items });
    }
});
