import dayjs from 'dayjs';
import { API_SERVER } from '../constants/globals';

export type UserStatus = 'active' | 'deleted' | 'unknown';

export interface UserStatusResponse {
    status: UserStatus;
    deletedAt?: string;
}

/** The probe is a boot-path call; a hung connection must not hold up the sync pass behind it. */
const USER_STATUS_TIMEOUT_MS = 5_000;

/**
 * Unauthenticated tombstone probe: `GET /auth/user-status?userId=`. A device whose session cookie
 * expired long ago (the year-offline case) can still ask whether the account it holds in IDB was
 * deleted server-side, using only the userId it already knows.
 *
 * Fail-open on purpose: a 429, a 5xx, a malformed body, a timeout or a network error all read as
 * `'unknown'`, which callers treat exactly like `'active'`. Only an explicit `'deleted'` answer may
 * wipe local data — a transient outage must never erase a user's offline queue.
 */
export async function fetchUserStatus(userId: string): Promise<UserStatusResponse> {
    try {
        // credentials: 'omit' — the whole point is that this works without a live session cookie.
        const res = await fetch(`${API_SERVER}/auth/user-status?userId=${encodeURIComponent(userId)}`, {
            credentials: 'omit',
            signal: AbortSignal.timeout(USER_STATUS_TIMEOUT_MS),
        });
        if (!res.ok) {
            return { status: 'unknown' };
        }
        return parseUserStatus(await res.json());
    } catch {
        return { status: 'unknown' };
    }
}

function parseUserStatus(body: unknown): UserStatusResponse {
    if (typeof body !== 'object' || body === null) {
        return { status: 'unknown' };
    }
    const { status, deletedAt } = body as { status?: unknown; deletedAt?: unknown };
    if (status !== 'active' && status !== 'deleted' && status !== 'unknown') {
        return { status: 'unknown' };
    }
    return typeof deletedAt === 'string' ? { status, deletedAt } : { status };
}

interface ErrorBody {
    error?: unknown;
    code?: unknown;
    sessionUserId?: unknown;
}

/** The server refused because the cookie session belongs to a different account than the UI manages. */
export const SESSION_MISMATCH_CODE = 'session_mismatch';

/**
 * Thin wrapper around fetch errors so callers can branch on status and on the server's error `code`
 * (e.g. 409 `session_mismatch`, which also carries the account the cookie actually resolved to).
 */
export class AccountApiError extends Error {
    readonly status: number;
    readonly code: string | undefined;
    readonly sessionUserId: string | undefined;
    constructor(status: number, message: string, details: { code?: string; sessionUserId?: string } = {}) {
        super(message);
        this.status = status;
        this.code = details.code;
        this.sessionUserId = details.sessionUserId;
    }
}

async function throwIfNotOk(response: Response, fallback: string): Promise<void> {
    if (response.ok) {
        return;
    }
    const body = (await response.json().catch(() => ({}))) as ErrorBody;
    throw new AccountApiError(response.status, typeof body.error === 'string' ? body.error : fallback, {
        ...(typeof body.code === 'string' ? { code: body.code } : {}),
        ...(typeof body.sessionUserId === 'string' ? { sessionUserId: body.sessionUserId } : {}),
    });
}

function parseDeletedUserId(body: unknown, status: number): string {
    const deletedUserId = typeof body === 'object' && body !== null ? (body as { deletedUserId?: unknown }).deletedUserId : undefined;
    if (typeof deletedUserId !== 'string' || deletedUserId.length === 0) {
        throw new AccountApiError(status, 'Unexpected response from the server — the account may not have been deleted.');
    }
    return deletedUserId;
}

/**
 * `DELETE /auth/me?expectedUserId=` — hard-deletes the signed-in account server-side (every
 * collection, the Better Auth session included). `expectedUserId` is the account the UI is acting
 * on: when the cookie session has drifted to another signed-in account the server answers 409
 * `session_mismatch` and deletes nothing. The caller must evaporate the local IDB rows afterwards;
 * the session cookie is dead once this resolves.
 */
export async function deleteMyAccount(expectedUserId: string): Promise<{ deletedUserId: string }> {
    const res = await fetch(`${API_SERVER}/auth/me?expectedUserId=${encodeURIComponent(expectedUserId)}`, { method: 'DELETE', credentials: 'include' });
    await throwIfNotOk(res, `delete account failed (${res.status})`);
    return { deletedUserId: parseDeletedUserId(await res.json(), res.status) };
}

/**
 * Picks the download filename out of a `Content-Disposition: attachment; filename="…"` header,
 * falling back to a dated default when the header is missing or carries no filename.
 */
export function exportFilenameFromHeader(contentDisposition: string | null, fallbackDate: string): string {
    const match = contentDisposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    const headerName = match?.[1]?.trim();
    return headerName && headerName.length > 0 ? headerName : `done-export-${fallbackDate}.json`;
}

/**
 * `GET /export?expectedUserId=` — the user's full server-side data as one JSON file, saved through a
 * Blob download. Same `expectedUserId` guard as deletion: a drifted cookie must not hand the user
 * another account's export.
 */
export async function downloadMyData(expectedUserId: string): Promise<void> {
    const res = await fetch(`${API_SERVER}/export?expectedUserId=${encodeURIComponent(expectedUserId)}`, { credentials: 'include' });
    await throwIfNotOk(res, `export failed (${res.status})`);
    const filename = exportFilenameFromHeader(res.headers.get('Content-Disposition'), dayjs().format('YYYY-MM-DD'));
    downloadBlob(await res.blob(), filename);
}

function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    // Deferred: Safari starts the download asynchronously and cancels it if the URL is revoked
    // synchronously after click().
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
