import CssBaseline from '@mui/material/CssBaseline';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import type { RouterContext } from '../types/routerContext';

function RootComponent() {
    return (
        <>
            <CssBaseline />
            <Outlet />
            {import.meta.env.DEV && <TanStackRouterDevtools />}
        </>
    );
}

export const Route = createRootRouteWithContext<RouterContext>()({
    component: RootComponent,
});
