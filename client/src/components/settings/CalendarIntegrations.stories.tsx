import type { Decorator, Meta, StoryObj } from '@storybook/react';
import { useEffect, useRef } from 'react';
import { fn } from 'storybook/test';
import { SettingsRouterDecorator } from '../../../.storybook/RouterDecorator';
import type { CalendarIntegration } from '../../api/calendarApi';
import type { AppData } from '../../contexts/AppDataProvider';
import { AppDataContext } from '../../contexts/AppDataProvider';
import { mockDb } from '../../test-utils/storybookMocks';
import { CalendarIntegrations } from './CalendarIntegrations';

// ── Mock AppData context value ─────────────────────────────────────────────────

const mockAppData: AppData = {
    account: null,
    items: [],
    workContexts: [],
    people: [],
    routines: [],
    refreshItems: fn().mockResolvedValue(undefined),
    refreshWorkContexts: fn().mockResolvedValue(undefined),
    refreshPeople: fn().mockResolvedValue(undefined),
    refreshRoutines: fn().mockResolvedValue(undefined),
    syncAndRefresh: fn().mockResolvedValue(undefined),
};

const MockAppDataDecorator: Decorator = (Story) => (
    <AppDataContext.Provider value={mockAppData}>
        <Story />
    </AppDataContext.Provider>
);

// ── Fetch mock component ───────────────────────────────────────────────────────

interface ApiMockConfig {
    integrations: CalendarIntegration[];
    shouldFail: boolean;
    hang: boolean;
}

/**
 * Installs a window.fetch mock for the duration of its lifecycle.
 * The mock intercepts requests to /calendar/integrations so stories don't need a live API.
 * Using a component (instead of synchronous decorator code) ensures the mock is active
 * when React effects fire — plain decorator code runs before React schedules effects.
 */
function FetchMockProvider({ config, children }: { config: ApiMockConfig; children: React.ReactNode }) {
    const originalFetchRef = useRef(window.fetch);

    useEffect(() => {
        window.fetch = async (input, init) => {
            // input is narrowed to Request by exclusion after the string and URL checks.
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

            if (url.includes('/calendar/integrations') && !url.includes('/calendars')) {
                if (config.hang) return new Promise<Response>(() => {});
                if (config.shouldFail) return new Response('Internal Server Error', { status: 500 });
                return new Response(JSON.stringify(config.integrations), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            return originalFetchRef.current(input, init);
        };
        return () => {
            window.fetch = originalFetchRef.current;
        };
    }, [config]);

    return <>{children}</>;
}

function withFetchMock(config: ApiMockConfig): Decorator {
    return (Story) => (
        <FetchMockProvider config={config}>
            <Story />
        </FetchMockProvider>
    );
}

// ── Meta ────────────────────────────────────────────────────────────────────────

const meta = {
    title: 'Components/CalendarIntegrations',
    component: CalendarIntegrations,
    parameters: { layout: 'padded' },
    tags: ['autodocs'],
    decorators: [MockAppDataDecorator, SettingsRouterDecorator],
    args: { db: mockDb },
} satisfies Meta<typeof CalendarIntegrations>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Loading state — the fetch hangs so the CircularProgress spinner stays visible.
 */
export const LoadingState: Story = {
    decorators: [withFetchMock({ integrations: [], shouldFail: false, hang: true })],
};

/**
 * No integrations — the API returns an empty array.
 * Shows "No calendars connected." and the Connect button.
 */
export const NoIntegrations: Story = {
    decorators: [withFetchMock({ integrations: [], shouldFail: false, hang: false })],
};

/**
 * One integration connected. A secondary fetch to /calendars is triggered per integration row;
 * that fetch is not intercepted so it will show a fetch error within the row (expected in Storybook).
 */
export const WithOneIntegration: Story = {
    decorators: [
        withFetchMock({
            integrations: [
                {
                    _id: 'int-1',
                    provider: 'google',
                    createdTs: '2024-01-15T10:00:00.000Z',
                    updatedTs: '2024-01-15T10:00:00.000Z',
                    lastSyncedTs: '2024-03-20T08:30:00.000Z',
                },
            ],
            shouldFail: false,
            hang: false,
        }),
    ],
};

/**
 * Error state — the API returns a 500. The error message replaces the list.
 */
export const ErrorState: Story = {
    decorators: [withFetchMock({ integrations: [], shouldFail: true, hang: false })],
};
