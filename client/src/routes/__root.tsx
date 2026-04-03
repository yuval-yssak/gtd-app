import CssBaseline from '@mui/material/CssBaseline';
import { CssVarsProvider, extendTheme } from '@mui/material/styles';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import type { RouterContext } from '../types/routerContext';

// colorSchemes: both light and dark must be listed so MUI generates dark CSS variables.
// colorSchemeSelector: attribute-based (not 'media') so useColorScheme().setMode() works
// for the manual toggle in Settings. CssVarsProvider defaults to defaultMode="system",
// which reads the OS preference and falls back to localStorage on subsequent visits.
const theme = extendTheme({
    colorSchemes: { light: true, dark: true },
    colorSchemeSelector: '[data-color-scheme="%s"]',
});

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
