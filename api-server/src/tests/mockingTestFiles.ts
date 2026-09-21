import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Test files that stub a module with `vi.mock`. vitest.config.ts routes them to the `isolated`
 * project (own process): under `isolate: false` the mock registry outlives the file and the stub
 * would leak into whatever file the worker runs next. Recursive, so a file in a subdirectory is
 * routed too. Only `*.test.ts` files are scanned — a `vi.mock` in a shared helper module would not
 * be detected, so helpers must not call it. Paths are returned relative to `testsDir`'s parent
 * layout as `<testsDir>/<file>`.
 */
export function findMockingTestFiles(testsDir: string): string[] {
    return readdirSync(testsDir, { recursive: true, encoding: 'utf8' })
        .filter((name) => name.endsWith('.test.ts'))
        .filter((name) => readFileSync(join(testsDir, name), 'utf8').includes('vi.mock('))
        .map((name) => join(testsDir, name));
}
