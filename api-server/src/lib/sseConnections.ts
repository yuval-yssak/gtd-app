// In-memory SSE connection registry keyed by userId.
// Works for a single process: Cloud Run runs this service with `--max-instances=1`, so every live
// connection for a user is in THIS map and a broadcast here (sync updates, `account-deleted`)
// reaches all of them. A multi-instance deployment would need Redis pub/sub instead.
const connections = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();

const encoder = new TextEncoder();

export function addSseConnection(userId: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
    const userSet = connections.get(userId) ?? new Set();
    if (!connections.has(userId)) connections.set(userId, userSet);
    userSet.add(controller);
    console.log(`[debug-gcal-sync][server] addSseConnection | userId=${userId} totalForUser=${userSet.size}`);
}

export function removeSseConnection(userId: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
    connections.get(userId)?.delete(controller);
    const remaining = connections.get(userId)?.size ?? 0;
    if (connections.get(userId)?.size === 0) connections.delete(userId);
    console.log(`[debug-gcal-sync][server] removeSseConnection | userId=${userId} totalForUser=${remaining}`);
}

/** Open controller count for a user. Lets tests assert the registry is not leaking dead streams. */
export function sseConnectionCountForUser(userId: string): number {
    return connections.get(userId)?.size ?? 0;
}

export function notifyUserViaSse(userId: string, payload: object): void {
    const chunk = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
    const controllers = connections.get(userId);
    const controllerCount = controllers?.size ?? 0;
    console.log(`[debug-gcal-sync][server] notifyUserViaSse | userId=${userId} controllerCount=${controllerCount} payload=${JSON.stringify(payload)}`);
    for (const controller of controllers ?? []) {
        try {
            controller.enqueue(chunk);
        } catch {
            // Controller is already closed — it will be removed when its disconnect handler fires
        }
    }
}

/**
 * Tells every live tab of a just-deleted user that the account is gone, then closes those
 * streams and drops them from the registry. Connected devices evaporate the account within
 * seconds; offline ones learn about it from `GET /auth/user-status` on their next boot. Returns
 * how many streams were closed (for the deletion report).
 */
export function broadcastAccountDeletedAndClose(userId: string): number {
    const controllers = connections.get(userId);
    if (!controllers) {
        return 0;
    }
    const chunk = encoder.encode(`data: ${JSON.stringify({ type: 'account-deleted', userId })}\n\n`);
    for (const controller of controllers) {
        try {
            controller.enqueue(chunk);
            controller.close();
        } catch {
            // Already closed by the client — nothing left to notify.
        }
    }
    connections.delete(userId);
    return controllers.size;
}
