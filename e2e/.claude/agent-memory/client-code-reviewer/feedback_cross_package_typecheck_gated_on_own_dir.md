---
name: feedback_cross_package_typecheck_gated_on_own_dir
description: New typecheck gates over code that imports another package (e2e specs importing client/src) get wired into the stop hook keyed only on their own directory's diff.
metadata:
  type: feedback
---

When a package's typecheck pulls in another package's source (e2e tsconfig includes `../client/src/types/**` and specs import client db/lib modules), the stop-hook block is still gated on `^e2e/` changes only. A client-only type change (e.g. `Omit<..., 'userId'>` on a dev hook) then breaks e2e types silently until someone next edits e2e — the exact way e2e drift accumulated before the tsrs migration added the gate.

**Why:** observed 2026-10-27 in the tsrs-compiler review; the drift fixed in that change came from client-side type edits.
**How to apply:** for any new cross-package check, verify the hook also runs it when the imported package changes (`CLIENT_CHANGED`), not just its own dir.
