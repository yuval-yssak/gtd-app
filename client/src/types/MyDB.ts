import { Dayjs } from "dayjs";
import { DBSchema } from "idb";

export type NumericBoolean = 0 | 1;

export type SyncOperation = {
    uuid: string; // by timestamp
    userId: string;
    itemId: string;
    action: "add" | "modify" | "delete";
    payload: unknown;
    synced: NumericBoolean;
};

export interface MyDB extends DBSchema {
    localLoggedIn: {
        key: string;
        value: {
            loggedInUsers: { id: string; email: string }[];
            activeUser: string;
        };
    };
    syncOperations: {
        key: string;
        value: SyncOperation;
        indexes: { synced: NumericBoolean; uuid: string };
    };
    items: {
        key: string;
        value: {
            id: string;
            userId: string;
            title: string;
            createdTs: Dayjs;
            type: "nextAction" | "calendar" | "waitingFor";
            people?: string[];
            workContexts?: string[];
            expectedBy?: Dayjs;
        };
        indexes: { id: string; type: "nextAction" | "calendar" | "waitingFor" };
    };
}
