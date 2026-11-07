/** A promise the test settles by hand, to hold async work at a chosen point. */
export function deferred<T = void>() {
    // let: the executor is the only place the resolver is handed out (Promise.withResolvers is ES2024).
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}
