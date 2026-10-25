import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import type { RouterContext } from '../types/routerContext';

function RootComponent() {
    return (
        <>
            <Outlet />
            {/* import.meta.env.DEV is false in preview builds; check URL so localhost gets devtools too */}
            {(import.meta.env.DEV || window.location.hostname === 'localhost') && <TanStackRouterDevtools />}
        </>
    );
}

export const Route = createRootRouteWithContext<RouterContext>()({
    component: RootComponent,
});
