/** A promise the test settles by hand, to hold async work at a chosen point. */
export function deferred<T = void>() {
    // let: the executor is the only place the settlers are handed out (Promise.withResolvers is ES2024).
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((settle, fail) => {
        resolve = settle;
        reject = fail;
    });
    return { promise, resolve, reject };
}
