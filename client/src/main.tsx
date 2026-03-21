import { openDB } from "idb";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/roboto/300.css";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";
import { App } from "./App";
import { MyDB } from "./types/MyDB";

async function startLocalDB() {
    const db = await openDB<MyDB>("my-first-store", 1, {
        upgrade(database, oldVersion, newVersion, transaction, event) {
            console.log("upgrade", { database, oldVersion, newVersion, transaction, event });
            if (oldVersion === 0) {
                // first time creating object stores
                console.log("creating collections", database);
                const items = database.createObjectStore("items", { keyPath: "id" });
                const syncOps = database.createObjectStore("syncOperations", { keyPath: "uuid" });
                const localLoggedIn = database.createObjectStore("localLoggedIn");
                console.log("created collections", { items, syncOps, localLoggedIn });
            }
        },
    });
    return db;
}

startLocalDB().then((db) => {
    createRoot(document.getElementById("root")!).render(
        <StrictMode>
            <App db={db} />
        </StrictMode>,
    );
});
