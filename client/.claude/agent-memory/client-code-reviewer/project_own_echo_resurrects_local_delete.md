---
name: own-echo-resurrects-local-delete
description: An in-flight pull can apply the device's OWN earlier create op after a local delete (existingTs none) and resurrect the row; applyEntityOp doesn't consult pending delete ops.
metadata:
  type: project
---

Found 2026-10-21 while stress-running a brief Clear e2e: clear → delete op queued, row gone; a pull already in flight then applied this device's earlier itemBrief create echo (no local row → LWW has nothing to compare) and the row came back.

**Why:** applyEntityOp treats "no local row" as "accept"; it does not check syncOperations for a pending local delete of that entityId. Reported to the user separately; the e2e works around it with `gtd.pull` before clearing.

**How to apply:** For delete/clear flows, ask whether a concurrent pull can re-create the row; don't approve e2e workarounds that hide it without confirming the race is tracked. Related: [[lww-escape-hatch-needs-negative-test]].
