/**
 * An abort signal that fires after `ms` unless cleared first. A request on a network that never
 * answers ("lie-fi") is otherwise held open by the browser for minutes, and whatever waits on it
 * waits as long.
 *
 * Callers clear it once the response headers arrive: a hang shows as headers that never come, while
 * a long body is a slow but progressing download (an unpaginated catch-up pull) that must not be cut.
 * Built on setTimeout rather than `AbortSignal.timeout` so it can be cleared, and faked in tests.
 */
export function startDeadline(ms: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException(`No answer within ${ms}ms`, 'TimeoutError')), ms);
    return { signal: controller.signal, clear: () => clearTimeout(timer), abort: (reason: unknown) => controller.abort(reason) };
}

/**
 * Fetches, giving up if the response headers have not arrived within `ms`. A caller's own signal
 * still aborts the request (forwarded by hand: `AbortSignal.any` is newer than the Safari target).
 */
export async function fetchWithHeadersDeadline(url: string | URL | Request, init: RequestInit & { deadlineMs: number }): Promise<Response> {
    const { deadlineMs, signal: callerSignal, ...requestInit } = init;
    const deadline = startDeadline(deadlineMs);
    const stopForwarding = forwardAbort(callerSignal, deadline.abort);
    try {
        return await fetch(url, { ...requestInit, signal: deadline.signal });
    } finally {
        deadline.clear();
        stopForwarding();
    }
}

function forwardAbort(source: AbortSignal | null | undefined, abort: (reason: unknown) => void): () => void {
    if (!source) {
        return () => undefined;
    }
    if (source.aborted) {
        abort(source.reason);
        return () => undefined;
    }
    const onAbort = () => abort(source.reason);
    source.addEventListener('abort', onAbort, { once: true });
    return () => source.removeEventListener('abort', onAbort);
}
