import { API_SERVER } from '../constants/globals';
import { fetchWithHeadersDeadline } from './deadlineSignal';

interface PushStatusResponse {
    registered: boolean;
}

/** How long Settings waits for the push status before showing "not registered". */
export const PUSH_STATUS_DEADLINE_MS = 10_000;

/**
 * Whether the server still holds a `pushSubscriptions` row for this device.
 * Used by Settings to surface a "Re-enable notifications" CTA when the row was purged
 * server-side (e.g. after a 410 Gone) while the browser still believes it's subscribed.
 *
 * Any failure — an error answer, the network, no answer in time — reads as "not registered" rather
 * than crashing the Settings page or leaving its button spinning.
 */
export async function getPushStatus(deviceId: string): Promise<PushStatusResponse> {
    try {
        const res = await fetchWithHeadersDeadline(`${API_SERVER}/push/status`, {
            credentials: 'include',
            // Header (not query) so it parallels the auth-middleware contract for X-Device-Id.
            headers: { 'X-Device-Id': deviceId },
            deadlineMs: PUSH_STATUS_DEADLINE_MS,
        });
        if (!res.ok) {
            return { registered: false };
        }
        // res.json() returns Promise<unknown>; cast narrowly to the shape the server contract guarantees.
        return (await res.json()) as PushStatusResponse;
    } catch {
        return { registered: false };
    }
}

/**
 * Tells the server the current account is signing out from this device. The server drops the
 * matching `deviceUsers` row so push fan-out for that account stops targeting this device.
 *
 * Must be called BEFORE Better Auth's signOut — once the session cookie is gone the server
 * can't authenticate this request.
 */
export async function signOutDevice(deviceId: string) {
    await fetch(`${API_SERVER}/devices/signout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId }),
    });
}
