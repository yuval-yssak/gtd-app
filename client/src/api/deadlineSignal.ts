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
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** Fetches, giving up if the response headers have not arrived within `ms`. */
export async function fetchWithHeadersDeadline(url: string, init: RequestInit & { deadlineMs: number }): Promise<Response> {
    const { deadlineMs, ...requestInit } = init;
    const deadline = startDeadline(deadlineMs);
    try {
        return await fetch(url, { ...requestInit, signal: deadline.signal });
    } finally {
        deadline.clear();
    }
}
