---
name: mongodb-csot-timeoutms-verified-behaviour
description: Verified 2026-09-26 on mongodb 7.1.1 — per-op timeoutMS bounds selection/checkout/socket read on a CONNECTED client, but NOT the auto-connect of an unconnected one (30s)
metadata:
  type: project
---

Empirically verified (throwaway mongo:8.0 + `docker pause`/`stop`) on driver 7.1.1: `db.command({ping:1}, {timeoutMS:1000})` on an already-`connect()`ed client fails in ~1.0 s as `MongoOperationTimeoutError` for socket read, connection checkout and server selection. On a client that was never connected, the auto-connect ignores the op's timeoutMS and takes the client `serverSelectionTimeoutMS` (30 s default).

**Why:** reviewers (and authors) assume CSOT bounds everything; the unconnected path is the exception.
**How to apply:** a timeoutMS-bounded probe/health check is sound only if the process awaits `client.connect()` before serving (index.ts does). Flag any new probe on a lazily-connected client; don't demand a Promise.race fallback for the connected case. Re-verify on driver major bumps — `timeoutMS` is still typed `@experimental`.
