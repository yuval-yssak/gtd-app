import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import styled from "@emotion/styled";
import { Header } from "../Pages/Header";
import { RouterContext } from "../types/routerContextTypes";

const RootDiv = styled.div`
    display: grid;
    grid-template-rows: max-content 1fr;
    height: 100%;
    gap: 1rem;
`;


function RootComponent() {
    // useRedirectToLoginAndBack();

    return (
        <RootDiv id="app-root">
            <Header />
            <Outlet />
        </RootDiv>
    );
}

// function useRedirectToLoginAndBack() {
//     const { auth } = Route.useRouteContext();
//     const navigate = Route.useNavigate();
//     const location = useLocation();
//     useEffect(() => {
//         if (auth === "no" && location.href !== "/login") {
//             localStorage.setItem("last-location", location.pathname);
//             navigate({ to: "/login" });
//             return;
//         }

//         const lastLocation = localStorage.getItem("last-location");
//         if (auth === "yes" && lastLocation) {
//             navigate({ to: lastLocation });
//             localStorage.removeItem("last-location");
//         }
//     }, [auth, location, navigate]);
// }

export const Route = createRootRouteWithContext<RouterContext>()({
    component: RootComponent,
});
