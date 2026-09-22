---
name: deploy-no-traffic-async-false-success
description: The deploy workflow splits deploy from traffic promotion; the promote step is load-bearing, and --async there would report green while the old revision still serves
metadata:
  type: project
---

`.github/workflows/deploy-api.yml` deploys with `--no-traffic`, promotes in a separate
`timeout 300 gcloud run services update-traffic --to-latest` step, and then verifies in a third
step that the serving revision equals `latestReadyRevisionName`, failing the job if they never
converge.

**Why:** letting `gcloud run deploy` migrate traffic made it block on the `--max-instances=1`
drain and time out (2026-09-22: 59m rollout, exit 1 on a revision that was actually healthy).
Splitting bounds the deploy step by image rollout alone. See
[[project_sse_stream_lifetime_cap_deploy_coupling]] for why the drain is slow.

**How to apply:** two non-obvious properties to re-check on any edit to these steps.

- **The promote step is REQUIRED, not optional.** `--no-traffic` pins the service to an explicit
  per-revision traffic split and turns OFF `latestRevision: true` float-to-LATEST. Once that
  happens, *every subsequent deploy* inherits the pinned split, so dropping the promote step
  doesn't just skip one rollout — it silently wedges all future ones on the old revision while
  the workflow stays green. `--to-latest` is what restores floating.
- **Do not reintroduce `--async` on the promote.** It returns after recording intent, so the job
  would go green before Cloud Run migrated anything; if the new revision never passes readiness,
  Cloud Run refuses the shift and nothing in CI notices — a false success, which given the pinning
  above wedges all later deploys too. This was caught in review and fixed before shipping: the
  promote is a bounded `timeout 300` wait, backed by the verify step. Equally, do NOT move the
  wait back into `gcloud run deploy` — that is what caused the original 59m timeout.
- **The verify step's `status.traffic[0]` assumes a single-target split.** True while the workflow
  only ever does `--to-latest`, but a future gradual rollout (`--to-revisions A=50,B=50`) would
  make index 0 arbitrary and the check meaningless-but-green. If traffic splitting is ever
  introduced, switch to matching `latestReadyRevisionName` against the whole `status.traffic`
  list with a 100% share, not element 0.
