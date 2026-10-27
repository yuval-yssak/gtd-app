import type { Meta, StoryObj } from '@storybook/react';
import dayjs from 'dayjs';
import { expect, waitFor, within } from 'storybook/test';
import type { ConnectedDevice, ConnectedDevicesPayload } from '../../api/devicesApi';
import { mockDb } from '../../test-utils/storybookMocks';
import { ConnectedDevices } from './ConnectedDevices';

// ── Fetch stub ──────────────────────────────────────────────────────────────────

/**
 * Answers GET /devices with the story's payload and passes every other request to the fetch it
 * wraps. Installed in `beforeEach` so it is live before the component's first fetch.
 */
function stubConnectedDevices(payload: ConnectedDevicesPayload) {
    return () => {
        const wrappedFetch = window.fetch;
        window.fetch = async (input, init) => {
            // input is narrowed to Request by exclusion after the string and URL checks.
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (!new URL(url, window.location.href).pathname.endsWith('/devices')) {
                return wrappedFetch(input, init);
            }
            return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
        };
        return () => {
            window.fetch = wrappedFetch;
        };
    };
}

function makeDevice(overrides: Partial<ConnectedDevice> & Pick<ConnectedDevice, 'deviceId'>): ConnectedDevice {
    return {
        lastSeenTs: dayjs().subtract(2, 'hour').toISOString(),
        lastSyncedTs: dayjs().subtract(2, 'hour').toISOString(),
        opsBehind: 0,
        holdsPurgeFloor: false,
        ...overrides,
    };
}

// ── Meta ────────────────────────────────────────────────────────────────────────

const meta = {
    title: 'Settings/ConnectedDevices',
    component: ConnectedDevices,
    parameters: { layout: 'padded' },
    // No autodocs: the docs page renders every story in one window, where each story's fetch stub would wrap the last.
    args: { db: mockDb },
} satisfies Meta<typeof ConnectedDevices>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Each device's last-reported build: one on the build running this page, one on another build
 * (flagged "Different build"), and one that synced only before builds were reported.
 */
export const BuildVersions: Story = {
    beforeEach: stubConnectedDevices({
        totalOps: 12,
        devices: [
            makeDevice({ deviceId: 'same', autoLabel: 'Chrome on macOS', appVersion: __COMMIT_HASH__ }),
            makeDevice({ deviceId: 'other', name: 'iPhone', appVersion: '0123abc', lastSeenTs: dayjs().subtract(3, 'day').toISOString() }),
            makeDevice({ deviceId: 'unreported', autoLabel: 'Safari on iOS', lastSeenTs: dayjs().subtract(9, 'day').toISOString(), opsBehind: 12 }),
        ],
    }),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await waitFor(async () => expect(await canvas.findAllByTestId('deviceRow')).toHaveLength(3));
        // Only the device on another reported build is flagged.
        await expect(canvas.getAllByTestId('differentBuildChip')).toHaveLength(1);
        await expect(canvas.getByText('Build 0123abc')).toBeVisible();
        await expect(canvas.getByText('Build not reported')).toBeVisible();
    },
};

/** Every device on the build running this page — no "Different build" chip anywhere. */
export const AllOnSameBuild: Story = {
    beforeEach: stubConnectedDevices({
        totalOps: 0,
        devices: [
            makeDevice({ deviceId: 'laptop', autoLabel: 'Chrome on macOS', appVersion: __COMMIT_HASH__ }),
            makeDevice({ deviceId: 'phone', name: 'iPhone', appVersion: __COMMIT_HASH__ }),
        ],
    }),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await waitFor(async () => expect(await canvas.findAllByTestId('deviceRow')).toHaveLength(2));
        await expect(canvas.queryByTestId('differentBuildChip')).toBeNull();
    },
};
