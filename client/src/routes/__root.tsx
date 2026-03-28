import CssBaseline from '@mui/material/CssBaseline';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import type { RouterContext } from '../types/routerContext';

function RootComponent() {
    console.log('Rendering RootComponent', import.meta);
    return (
        <>
            <CssBaseline />
            <Outlet />
            {/* import.meta.env.DEV is false in preview builds; check URL so localhost gets devtools too */}
            {(import.meta.env.DEV || window.location.hostname === 'localhost') && <TanStackRouterDevtools />}
        </>
    );
}

export const Route = createRootRouteWithContext<RouterContext>()({
    component: RootComponent,
});
