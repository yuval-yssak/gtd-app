// In-memory SSE connection registry keyed by userId.
// Works for a single process (Cloud Run single instance).
// For multi-instance deployments this would need to be replaced with Redis pub/sub.
const connections = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();

const encoder = new TextEncoder();

export function addSseConnection(userId: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
    const userSet = connections.get(userId) ?? new Set();
    if (!connections.has(userId)) connections.set(userId, userSet);
    userSet.add(controller);
}

export function removeSseConnection(userId: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
    connections.get(userId)?.delete(controller);
    if (connections.get(userId)?.size === 0) connections.delete(userId);
}

export function notifyUserViaSse(userId: string, payload: object): void {
    const chunk = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
    for (const controller of connections.get(userId) ?? []) {
        try {
            controller.enqueue(chunk);
        } catch {
            // Controller is already closed — it will be removed when its disconnect handler fires
        }
    }
}
