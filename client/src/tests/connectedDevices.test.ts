/** Tests for the pure display helpers of Settings → Connected devices
 * (`components/settings/ConnectedDevices.tsx`). Rendering is covered by the e2e spec. */
import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import type { ConnectedDevice } from '../api/devicesApi';
import {
    describeDeviceActivity,
    describeDeviceBuild,
    deviceDisplayName,
    isHoldingBackCleanup,
    isOnDifferentBuild,
    sortDevicesForDisplay,
    withThisDevicesBuild,
} from '../components/settings/ConnectedDevices';

function makeDevice(overrides: Partial<ConnectedDevice> & { deviceId: string }): ConnectedDevice {
    return {
        lastSeenTs: '2026-07-01T00:00:00.000Z',
        lastSyncedTs: '2026-07-01T00:00:00.000Z',
        opsBehind: 0,
        holdsPurgeFloor: false,
        ...overrides,
    };
}

describe('deviceDisplayName', () => {
    it('prefers the user-given name over the auto label', () => {
        expect(deviceDisplayName({ name: 'Work laptop', autoLabel: 'Chrome on macOS' })).toBe('Work laptop');
    });

    it('falls back to the auto label, then to a generic placeholder', () => {
        expect(deviceDisplayName({ autoLabel: 'Chrome on macOS' })).toBe('Chrome on macOS');
        expect(deviceDisplayName({})).toBe('Unknown device');
    });
});

describe('describeDeviceActivity', () => {
    const now = dayjs('2026-07-11T00:00:00.000Z');

    it('reports relative last-seen and an up-to-date state for zero lag', () => {
        const device = makeDevice({ deviceId: 'd1', lastSeenTs: '2026-07-08T00:00:00.000Z', opsBehind: 0 });
        expect(describeDeviceActivity(device, now)).toBe('Last seen 3 days ago · up to date');
    });

    it('pluralizes the operations-behind count correctly', () => {
        expect(describeDeviceActivity(makeDevice({ deviceId: 'd1', opsBehind: 1 }), now)).toContain('1 operation behind');
        expect(describeDeviceActivity(makeDevice({ deviceId: 'd1', opsBehind: 42 }), now)).toContain('42 operations behind');
    });
});

describe('isHoldingBackCleanup', () => {
    it('flags only a floor holder that is actually behind', () => {
        expect(isHoldingBackCleanup(makeDevice({ deviceId: 'd1', holdsPurgeFloor: true, opsBehind: 5 }))).toBe(true);
    });

    it('does not flag a caught-up floor holder or a lagging non-holder', () => {
        // Some device always holds the floor; a caught-up holder isn't blocking anything.
        expect(isHoldingBackCleanup(makeDevice({ deviceId: 'd1', holdsPurgeFloor: true, opsBehind: 0 }))).toBe(false);
        expect(isHoldingBackCleanup(makeDevice({ deviceId: 'd1', holdsPurgeFloor: false, opsBehind: 5 }))).toBe(false);
    });
});

describe('describeDeviceBuild', () => {
    it('names the build the device last reported', () => {
        expect(describeDeviceBuild({ appVersion: '8b77e17' })).toBe('Build 8b77e17');
    });

    it('says so when the device never reported a build (it predates the report)', () => {
        expect(describeDeviceBuild({})).toBe('Build not reported');
    });
});

describe('isOnDifferentBuild', () => {
    it('flags a device that reported a build other than the one running this page', () => {
        expect(isOnDifferentBuild({ appVersion: '245e5c6' }, '8b77e17')).toBe(true);
    });

    it('does not flag a device on the same build', () => {
        expect(isOnDifferentBuild({ appVersion: '8b77e17' }, '8b77e17')).toBe(false);
    });

    it('does not flag a device that never reported — there is nothing to compare', () => {
        expect(isOnDifferentBuild({}, '8b77e17')).toBe(false);
    });
});

describe('withThisDevicesBuild', () => {
    it('shows this device on the build rendering the page, even before its next pull reports it', () => {
        // Right after a Service Worker update + reload, the server still holds the previous hash.
        const thisDevice = makeDevice({ deviceId: 'me', appVersion: 'old0000' });
        const shown = withThisDevicesBuild([thisDevice, makeDevice({ deviceId: 'phone', appVersion: '0123abc' })], 'me');
        expect(shown.map((d) => d.appVersion)).toEqual([__COMMIT_HASH__, '0123abc']);
        expect(thisDevice.appVersion).toBe('old0000'); // input untouched
    });

    it('leaves every row as reported when this device is not yet known', () => {
        const devices = [makeDevice({ deviceId: 'phone', appVersion: '0123abc' })];
        expect(withThisDevicesBuild(devices, null)).toEqual(devices);
    });
});

describe('sortDevicesForDisplay', () => {
    it('puts the current device first, then orders by most recently seen', () => {
        const devices = [
            makeDevice({ deviceId: 'old', lastSeenTs: '2026-01-01T00:00:00.000Z' }),
            makeDevice({ deviceId: 'newest', lastSeenTs: '2026-07-10T00:00:00.000Z' }),
            makeDevice({ deviceId: 'me', lastSeenTs: '2026-03-01T00:00:00.000Z' }),
        ];
        expect(sortDevicesForDisplay(devices, 'me').map((d) => d.deviceId)).toEqual(['me', 'newest', 'old']);
    });

    it('leaves order by recency when the current device is unknown, without mutating the input', () => {
        const devices = [
            makeDevice({ deviceId: 'a', lastSeenTs: '2026-01-01T00:00:00.000Z' }),
            makeDevice({ deviceId: 'b', lastSeenTs: '2026-02-01T00:00:00.000Z' }),
        ];
        const sorted = sortDevicesForDisplay(devices, null);
        expect(sorted.map((d) => d.deviceId)).toEqual(['b', 'a']);
        expect(devices.map((d) => d.deviceId)).toEqual(['a', 'b']); // input untouched
    });
});
