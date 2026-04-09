import CssBaseline from '@mui/material/CssBaseline';
import { CssVarsProvider, extendTheme } from '@mui/material/styles';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import { useMemo } from 'react';
import { buildThemeOptions, useColorTheme } from '../lib/colorTheme';
import type { RouterContext } from '../types/routerContext';

function RootComponent() {
    const colorThemeId = useColorTheme();
    // Rebuild the MUI theme only when the user picks a different color theme.
    // colorSchemes must list both light and dark so MUI generates dark CSS variables.
    // colorSchemeSelector is attribute-based (not 'media') so useColorScheme().setMode()
    // works for the manual toggle in Settings.
    const theme = useMemo(() => extendTheme(buildThemeOptions(colorThemeId)), [colorThemeId]);

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
