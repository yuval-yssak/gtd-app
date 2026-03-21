// import { openDB } from "idb";
import Button from "@mui/material/Button";
import { useRouteContext } from "@tanstack/react-router";
import { BASE_SERVER_URL } from "../constants/globals";
import { x } from "../loaders/axios";

export function LoginPage() {
    const { auth, db } = useRouteContext({ from: "/login" });
    function onGoogleLogin() {
        location.href = `${BASE_SERVER_URL}/auth/google`;
    }
    async function onSignOut() {
        await x.post("/auth/sign-out");
        await db.clear("localLoggedIn");
        location.reload();
    }

    console.log({auth})

    if (auth.activeUser) {
        return (
            <>
                <h2>You are signed in as .... {auth.activeUser}</h2>
                <Button onClick={onSignOut}>Sign out</Button>
            </>
        );
    }

    return <Button onClick={onGoogleLogin}>Login with Google</Button>;
}
