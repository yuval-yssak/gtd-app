---
name: sse-stream-lifetime-cap-deploy-coupling
description: SSE stream lifetime is a deploy-latency knob because max-instances=1 makes a busy instance block the next revision; the cap trades reconnect request volume against drain time
metadata:
  type: project
---

`GET /sync/events` streams are bounded by `SSE_MAX_LIFETIME_MS` (`api-server/src/routes/sync.ts`)
purely to keep Cloud Run instances drainable. This is a three-way coupling that is invisible from
any one file:

1. **Cloud Run `--max-instances=1`** (set in `.github/workflows/deploy-api.yml`, required because
   `sseConnections.ts` is an in-process registry) caps the WHOLE service at one instance, so a new
   revision cannot start until the old instance drains.
2. **Open SSE streams keep the old instance busy.** Before the cap, streams died only at Cloud
   Run's `timeoutSeconds: 300`. Observed 2026-09-22: a staging rollout took 59 minutes and
   `gcloud run deploy` exited 1 at ~56m even though the revision was healthy.
3. **Every reconnect is a billed Cloudflare Worker request.** The free-tier daily cap has been hit
   before on this project (see the user-level memory on the 143k-req/day incident), so a tighter
   cap is not free.

**Why:** shortening the cap improves deploy latency and lengthening it reduces request volume;
there is no value that optimizes both. The chosen value (120s, ~9.4k req/day across ~13 tabs) is a
deliberate midpoint, not a round number someone picked.

**How to apply:** when reviewing any change to this constant, to `--max-instances`, or to the SSE
registry, check all three legs. In particular:
- A reconnect carries **no follow-on pull** — the `: connected` frame is an SSE *comment*, not an
  `update` message, so `handleMessage` never fires `onUpdate`. One reconnect == one request, full
  stop. Do not accept a cost estimate that assumes a pull per reconnect.
- The ~100s Cloudflare figure in `docs/gcp-deploy-plan.md` is a **time-to-first-byte** limit
  measured on a non-streaming endpoint (the brief sweep). It does not cap stream duration — the
  59-minute drain incident is direct evidence that streams lived to ~300s *through* the Worker.
  Don't cite it as a ceiling on the SSE cap.

Related: [[project_new_v1_route_misses_rate_limit_bucket]].
