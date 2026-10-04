/**
 * Resolves with `promise` if it settles within `ms`, otherwise rejects with a `${label} timed out`
 * error. Bounds how long the CALLER waits only — the underlying work keeps running to completion
 * (googleapis exposes no abort signal), which is acceptable for the best-effort Google calls that
 * use this: a stalled socket must not hold a request open until Cloud Run's 300 s limit kills it.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}
