/** True when the error is a MongoDB duplicate-key violation (E11000) from a unique index. */
export function isDuplicateKeyError(err: unknown): boolean {
    return err instanceof Error && 'code' in err && (err as { code: number }).code === 11000;
}
