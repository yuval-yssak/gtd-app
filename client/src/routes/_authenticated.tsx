import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { x } from "../loaders/axios";

async function checkAuth() {
    try {
        console.log("checking auth")
        return await x.get<{ id: string }>("/auth/check");
    } catch (e) {
        console.log(e);
        throw e;
    }
}

export const Route = createFileRoute("/_authenticated")({
    beforeLoad: async () => {
        try {
            await checkAuth();
        } catch (e) {
            console.log("error in check auth", e);
            throw redirect({ to: "/login" });
        }
    },
    component: () => <Outlet />,
});
