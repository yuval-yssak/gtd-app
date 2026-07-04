/**
 * Field-level live-merge policy for editors that stay open while sync updates the entity
 * underneath them.
 *
 * A form field is "clean" when its current value still equals the seed — the entity value the
 * form was last seeded (or merged) from. When a fresh entity version arrives:
 * - clean fields adopt the incoming value (the user never touched them, remote wins);
 * - dirty fields keep the local text (the user is mid-edit, local wins — for autosaved fields the
 *   local value re-commits within a debounce tick anyway).
 *
 * `mergeCleanStringFields` returns the merged form; callers then update their seed to the incoming
 * values so dirtiness stays defined against the latest persisted state.
 */

export function mergeCleanStringFields<T extends Record<string, string>>(form: T, seed: T, incoming: T): T {
    const merged = { ...form };
    for (const key of Object.keys(incoming) as Array<keyof T>) {
        if (form[key] === seed[key]) {
            merged[key] = incoming[key];
        }
    }
    return merged;
}

export function stringFieldsEqual<T extends Record<string, string>>(a: T, b: T): boolean {
    return Object.keys(a).every((key) => a[key] === b[key]);
}
