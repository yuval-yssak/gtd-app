import { createFileRoute } from "@tanstack/react-router";
import { InboxPage } from "../../../Pages/InboxPage";

export const Route = createFileRoute("/_authenticated/lists/inbox")({
    component: InboxPage,
});
