---
name: vitest-mock-detector-blind-spots
description: vitest.config.ts routes vi.mock files to an isolated project via a non-recursive readdirSync substring scan — subdirectories and non-.test.ts helpers are invisible to it
metadata:
  type: project
---

`api-server/vitest.config.ts` decides which files get their own process by scanning at config time:

```ts
readdirSync('src/tests')
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => readFileSync(`src/tests/${name}`, 'utf8').includes('vi.mock('))
```

Anything it misses lands in the `shared` project (`isolate: false`) where the mock registry outlives the file and leaks into whatever runs next on that worker.

Known blind spots, in rough order of likelihood:
1. **Subdirectories.** `readdirSync` is non-recursive, but the `shared` project's include is `src/tests/**/*.test.ts`. Verified: `src/tests/sub/x.test.ts` containing `vi.mock(` is listed as `[shared]`.
2. **Non-`.test.ts` files.** A `vi.mock` added to `helpers.ts` or `calendarTestKit.ts` is invisible (today neither uses one).
3. **Relative path.** `'src/tests'` resolves against `process.cwd()`, so the config only works when vitest is launched from `api-server/`. CI and `scripts/post-change-checks.sh` both `cd` there first, so it works — but it's fragile; `fileURLToPath(new URL('src/tests', import.meta.url))` would be robust.
4. Text substring, so `vi . mock(` or an aliased import would evade it (unlikely in practice).

**Why:** the failure mode is a mock from file A silently applying inside file B, which surfaces as an inexplicable pass/fail depending on worker scheduling — extremely expensive to debug.

**How to apply:** if a change adds a test subdirectory under `src/tests/`, or adds `vi.mock` to a shared helper, flag it and require the detector be made recursive (`readdirSync(dir, { recursive: true })`) or the file be added to the isolated list explicitly. Related: [[vitest-shared-worker-isolation-model]].
