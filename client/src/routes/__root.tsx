import { CssVarsProvider, extendTheme, useColorScheme } from '@mui/material/styles';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools';
import { useEffect } from 'react';
import { useResolvedColorScheme } from '../lib/colorScheme';
import type { RouterContext } from '../types/routerContext';

// Transitional: screens not yet on the design system still render MUI components, which read MUI's
// own palette. No CssBaseline — the design-system reset in tokens/base.css owns the document, and
// CssBaseline's unlayered element rules would override it.
const muiTheme = extendTheme({
    colorSchemes: { light: true, dark: true },
    colorSchemeSelector: '[data-color-scheme="%s"]',
});

/** Keeps MUI's scheme on whatever lib/colorScheme.ts resolved, so MUI and DS screens never disagree. */
function MuiColorSchemeBridge() {
    const scheme = useResolvedColorScheme();
    const { setMode } = useColorScheme();
    useEffect(() => {
        setMode(scheme);
    }, [scheme, setMode]);
    return null;
}

function RootComponent() {
    return (
        // storageManager={null}: MUI keeps its mode in memory only; lib/colorScheme.ts owns the persisted preference.
        <CssVarsProvider theme={muiTheme} storageManager={null}>
            <MuiColorSchemeBridge />
            <Outlet />
            {/* import.meta.env.DEV is false in preview builds; check URL so localhost gets devtools too */}
            {(import.meta.env.DEV || window.location.hostname === 'localhost') && <TanStackRouterDevtools />}
        </CssVarsProvider>
    );
}

export const Route = createRootRouteWithContext<RouterContext>()({
    component: RootComponent,
});
