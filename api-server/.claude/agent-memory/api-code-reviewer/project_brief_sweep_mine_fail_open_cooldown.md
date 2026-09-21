---
name: brief-sweep-mine-fail-open-cooldown
description: In-process env-tunable cooldowns used as the ONLY limiter on a session route fail open on empty-string env vars and reset on Cloud Run cold start
metadata:
  type: project
---

When a per-user cooldown (`Map<userId, ms>` + `Number(process.env.X)`) is the *sole* rate limiter
on a session-authed route that spends money, two failure modes recur in this repo and neither is
visible in tests:

1. **Empty-string fails open.** `Number('')` is `0`, so a guard written as
   `Number.isInteger(raw) && raw >= 0` accepts `''` and yields a 0 ms cooldown. The deploy workflow's
   established pattern is `X: "${{ vars.X }}"`, which writes `""` for an unset GitHub var — so
   documenting the var in `docs/gcp-deploy-plan.md` is enough to get someone to wire it and silently
   disable the limiter. Compare `briefCap.ts` `generationBucket()`, which uses `raw > 0` and therefore
   falls back correctly. Prefer `> 0` unless "0 disables" is genuinely wanted, and if it is, require
   an explicit sentinel rather than letting `''` mean it.
2. **In-process state resets on cold start.** Cloud Run scales to zero here, so a `Map` cooldown is
   erased on every cold start and every deploy — the user can re-trigger the full fan-out by
   reloading. Batch-pipeline guards in the same feature are DB-backed (`status:'processing'` row);
   the per-user one is not, and the asymmetry is easy to miss.

**Why:** brief generation has no daily USD backstop — `lib/claude/spend.ts`'s cap covers only
claude-assist — so these two together are the entire spend bound on that surface.

**How to apply:** on any new session-authed route that triggers model calls or other paid fan-out,
check (a) the env parse rejects `''`, (b) the limiter survives a restart, (c) whether a shared spend
cap should apply. Related: [[unbounded-server-only-bookkeeping-rows]].
