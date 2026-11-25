---
name: idb-loss-simulation-vs-webkit-mode
description: IDB connection-loss fixes get proven with close()-based simulation (sync InvalidStateError) while WebKit's real failure is an async UnknownError from a request inside a transaction that opened fine
metadata:
  type: project
---

The self-healing IndexedDB handle (fix/safari-idb-reconnect, 2026-11-26) was proven with `simulateConnectionLoss` = raw `close()`, which makes `db.transaction()` throw InvalidStateError synchronously. WebKit's real iOS-PWA failure ("...without an in-progress transaction", UnknownError) arrives asynchronously from a request/`tx.done` on a transaction that was created successfully — a path the close()-based e2e never exercises.

**Why:** a recovery hook that only watches sync throws and idb shortcut rejections leaves every explicit `db.transaction()` caller (bulkPutItems, pull apply, deleteSentOps, accountHelpers) failing without triggering a reopen.

**How to apply:** for any IDB-resilience change, ask which failure mode each test reproduces; demand a test where a request inside an explicit transaction rejects with UnknownError and the next call is served from a new connection. Related: [[no-dom-hook-test-gap]].
