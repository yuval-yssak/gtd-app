// biome-ignore lint/suspicious/noExplicitAny: concise way to express "at least one character exists"
export type NonEmptyString = `${any}${string}`;

/** A tuple type representing an array with at least one element. */
export type NonEmptyArray<T> = [T, ...T[]];

/** Narrows `T[]` to `NonEmptyArray<T>` — use instead of `arr[0]!` non-null assertions. */
export const hasAtLeastOne = <T>(arr: T[]): arr is NonEmptyArray<T> => arr.length > 0;
