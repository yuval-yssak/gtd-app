import { IDBPDatabase } from "idb";
import { MyDB } from "./MyDB";

// todo: remove duplicate - the same type exists in idb store type.
export type AuthContext = {
    loggedInUsers: { id: string; email: string }[];
    activeUser: string;
    activeEmail: string;
};

export interface Item {
    user: string;
    status: "inbox" | "nextAction" | "calendar" | "waitingFor" | "done" | "trash";
    title: string;
    createdTs: string;
    /**
     * relevant only for `nextAction` type items
     */
    workContexts?: string[];
    people?: string[];
    /**
     * relevant only for `nextAction` or `waitingFor` type items
     *
     * One-day resolution
     */
    expectedBy?: string;
    /**
     * relevant only for `calendar` type items
     */
    timeStart?: string;
    /**
     * relevant only for `calendar` type items
     */
    timeEnd?: string;
    /**
     * relevant only for `nextAction` type items
     */
    energy?: "low" | "medium" | "high";
    /**
     * relevant only for `nextAction` type items
     *
     * In minutes
     */
    time?: number;
    /**
     * relevant only for `nextAction` type items
     *
     */
    focus?: boolean;
    /**
     * relevant only for `nextAction` type items
     */
    urgent?: boolean;
}

export type RouterContext = {
    auth: AuthContext;
    db: IDBPDatabase<MyDB>;
    items: Item[];
};
