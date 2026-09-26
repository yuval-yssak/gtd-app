---
name: prod-env-provisioning-lags-staging
description: Production GitHub env lacks CRON_SECRET/VAPID/Anthropic keys and has no Scheduler jobs; changes that remove a prod fallback in favour of Scheduler silently disable the feature there
metadata:
  type: project
---

As of 2026-09-26, `gh secret list --env production` / `gh variable list --env production` show production has CALENDAR_WEBHOOK_URL but NO CRON_SECRET (so every `requireCronSecret` endpoint 401s) and no VAPID keys; the prod Scheduler job was only documented "to create". The prod-readiness week-1 change gated the in-process webhook-renewal timer off under NODE_ENV=production, which would have left prod with zero renewal mechanism.

**Why:** staging is the environment everyone tests against; prod config drifts behind and nobody notices because prod deploys are rare.
**How to apply:** whenever a change turns off a fallback in production or makes production depend on an env var / Scheduler job, run `gh secret list --env production` + `gh variable list --env production` and demand either the provisioning happen before deploy or a gate that keeps the fallback while the dependency is absent. Related: [[scripts-bypassing-loaddataaccess-lose-guards]].
