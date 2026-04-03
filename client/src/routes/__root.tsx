import CssBaseline from '@mui/material/CssBaseline';
import { CssVarsProvider, extendTheme } from '@mui/material/styles';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import type { RouterContext } from '../types/routerContext';

// colorSchemeSelector: 'media' makes MUI switch palettes via prefers-color-scheme,
// so the app follows the OS dark/light setting without a manual toggle.
const theme = extendTheme({ colorSchemeSelector: 'media' });

function RootComponent() {
    return (
        <CssVarsProvider theme={theme}>
            <CssBaseline />
            <Outlet />
            {/* import.meta.env.DEV is false in preview builds; check URL so localhost gets devtools too */}
            {(import.meta.env.DEV || window.location.hostname === 'localhost') && <TanStackRouterDevtools />}
        </CssVarsProvider>
    );
}

export const Route = createRootRouteWithContext<RouterContext>()({
    component: RootComponent,
});
