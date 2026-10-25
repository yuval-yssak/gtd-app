import type { Decorator, Meta, StoryObj } from '@storybook/react';
import { SettingsRouterDecorator } from '../../../.storybook/RouterDecorator';
import type { CalendarIntegration } from '../../api/calendarApi';
import { AppDataContext } from '../../contexts/AppDataProvider';
import { buildMockAppData } from '../../test-utils/storybookAppData';
import { CalendarIntegrations } from './CalendarIntegrations';

// ── Mock AppData context value ─────────────────────────────────────────────────

const mockAppData = buildMockAppData();

const MockAppDataDecorator: Decorator = (Story) => (
    <AppDataContext.Provider value={mockAppData}>
        <Story />
    </AppDataContext.Provider>
);

// ── Fetch stub ──────────────────────────────────────────────────────────────────

interface ApiMockConfig {
    integrations: CalendarIntegration[];
    shouldFail: boolean;
    hang: boolean;
}

/**
 * Answers /calendar/integrations from the story's config and passes every other request to the
 * fetch it wraps. Installed in `beforeEach` so it is live before the component's first fetch.
 */
function stubCalendarIntegrations(config: ApiMockConfig) {
    return () => {
        const wrappedFetch = window.fetch;
        window.fetch = async (input, init) => {
            // input is narrowed to Request by exclusion after the string and URL checks.
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (!url.includes('/calendar/integrations') || url.includes('/calendars')) {
                return wrappedFetch(input, init);
            }
            if (config.hang) {
                return new Promise<Response>(() => {});
            }
            if (config.shouldFail) {
                return new Response('Internal Server Error', { status: 500 });
            }
            return new Response(JSON.stringify(config.integrations), { status: 200, headers: { 'Content-Type': 'application/json' } });
        };
        return () => {
            window.fetch = wrappedFetch;
        };
    };
}

// ── Meta ────────────────────────────────────────────────────────────────────────

const meta = {
    title: 'Components/CalendarIntegrations',
    component: CalendarIntegrations,
    parameters: { layout: 'padded' },
    // No autodocs: the docs page renders every story in one window, where each story's fetch stub would wrap the last.
    decorators: [MockAppDataDecorator, SettingsRouterDecorator],
} satisfies Meta<typeof CalendarIntegrations>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Loading state — the fetch hangs so the CircularProgress spinner stays visible.
 */
export const LoadingState: Story = {
    beforeEach: stubCalendarIntegrations({ integrations: [], shouldFail: false, hang: true }),
};

/**
 * No integrations — the API returns an empty array.
 * Shows "No calendars connected." and the Connect button.
 */
export const NoIntegrations: Story = {
    beforeEach: stubCalendarIntegrations({ integrations: [], shouldFail: false, hang: false }),
};

/**
 * One integration connected. A secondary fetch to /calendars is triggered per integration row;
 * that fetch is not intercepted, so the row shows the Storybook API stub's error (expected).
 */
export const WithOneIntegration: Story = {
    beforeEach: stubCalendarIntegrations({
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
};

/**
 * Error state — the API returns a 500. The error message replaces the list.
 */
export const ErrorState: Story = {
    beforeEach: stubCalendarIntegrations({ integrations: [], shouldFail: true, hang: false }),
};
