import { API_SERVER } from '../constants/globals';

interface PushStatusResponse {
    registered: boolean;
}

/**
 * Whether the server still holds a `pushSubscriptions` row for this device.
 * Used by Settings to surface a "Re-enable notifications" CTA when the row was purged
 * server-side (e.g. after a 410 Gone) while the browser still believes it's subscribed.
 */
export async function getPushStatus(deviceId: string) {
    const res = await fetch(`${API_SERVER}/push/status`, {
        credentials: 'include',
        // Header (not query) so it parallels the auth-middleware contract for X-Device-Id.
        headers: { 'X-Device-Id': deviceId },
    });
    if (!res.ok) {
        // Treat any failure as "unknown / not registered" rather than crashing the Settings page.
        return { registered: false };
    }
    // res.json() returns Promise<unknown>; cast narrowly to the shape the server contract guarantees.
    return res.json() as Promise<PushStatusResponse>;
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
