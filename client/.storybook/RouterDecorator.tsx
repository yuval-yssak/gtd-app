import type { Decorator } from '@storybook/react';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';

/**
 * A generic memory router that wraps a story in a TanStack Router context.
 * Required for any component that calls useNavigate(), useLocation(), Link, etc.
 * The initial location defaults to '/' unless overridden via story parameters.
 *
 * Usage in a story file:
 *   decorators: [RouterDecorator]
 *
 * To start at a specific path:
 *   parameters: { router: { initialPath: '/settings' } }
 */
export const RouterDecorator: Decorator = (Story, context) => {
    const initialPath: string = (context.parameters?.['router'] as { initialPath?: string } | undefined)?.initialPath ?? '/';

    const rootRoute = createRootRoute({ component: Outlet });
    const catchAllRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '$',
        component: Story,
    });
    const indexRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/',
        component: Story,
    });
    const routeTree = rootRoute.addChildren([indexRoute, catchAllRoute]);
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [initialPath] }),
    });
    return <RouterProvider router={router} />;
};

/**
 * A specialized router decorator for the Settings page context.
 * Registers the /_authenticated/settings route so that components calling
 * useSearch({ from: '/_authenticated/settings' }) resolve correctly.
 */
export const SettingsRouterDecorator: Decorator = (Story, context) => {
    const calendarConnected = (context.parameters?.['router'] as { calendarConnected?: boolean } | undefined)?.calendarConnected;

    const rootRoute = createRootRoute({ component: Outlet });
    const authenticatedRoute = createRoute({
        getParentRoute: () => rootRoute,
        id: '_authenticated',
        component: Outlet,
    });
    const settingsRoute = createRoute({
        getParentRoute: () => authenticatedRoute,
        path: '/settings',
        component: Story,
        validateSearch: (search: Record<string, unknown>) => ({
            calendarConnected: search['calendarConnected'] as boolean | undefined,
        }),
    });
    const routeTree = rootRoute.addChildren([authenticatedRoute.addChildren([settingsRoute])]);

    const initialSearch = calendarConnected != null ? `?calendarConnected=${calendarConnected}` : '';
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [`/settings${initialSearch}`] }),
    });
    return <RouterProvider router={router} />;
};
