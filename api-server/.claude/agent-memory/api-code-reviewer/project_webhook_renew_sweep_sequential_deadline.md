---
name: webhook-renew-sweep-sequential-deadline
description: POST /calendar/webhooks/renew runs one sequential sweep (stop+watch, plus catch-up sync on lapsed channels) with no time budget, under a 300s Scheduler attempt deadline and Cloud Run's default 300s timeout
metadata:
  type: project
---

Since 2026-10-27 (branch fix/webhook-renew-failure-logging) the cron renew route delegates to the shared `renewAllExpiring()`, which runs sequentially. Before that it ran in parallel. Lapsed channels also run a catch-up sync, and when the syncToken has expired that sync becomes a 410 → full sync. A module-level `renewing` guard makes a concurrent call return `{renewed:0, failed:0}`, which looks exactly like a run with nothing to renew.

**Why:** a mass lapse (Scheduler outage longer than 7 days, or a reconnect wave) can push the sequential sweep past the 300s deadline. Scheduler then logs a failure, and every overlapping retry silently returns zeros.

**How to apply:** when this sweep changes, ask for a wall-clock budget or a "still running" signal, and check that per-config work stays cheap. Accepted as non-blocking at today's small number of configs.
