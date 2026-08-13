---
name: local-first-gesture-leaves-server-state-behind
description: Converting an online gesture (account switch) to local-first IDB+reload leaves a server-side session/cookie that only a foreground React path reconciles — SW/background contexts still read the drifted state.
metadata:
  type: feedback
---

When a gesture is converted from "online round-trip" to "local-first IDB write + hard reload", the
server-side counterpart (Better Auth active-session cookie) does NOT move with it. The reconcile is
then placed only in React-owned paths (AppDataProvider boot effect + isOnline effect), which means
every non-React context that reads `getActiveAccount(db)` — the Service Worker `sync` and `push`
handlers above all — keeps operating on IDB's new value while the cookie still authenticates as the
previous account.

**Why:** IDB `activeAccount` is shared across contexts; the cookie is shared too but only the tab
reconciles it. A SW background flush/pull between the offline switch and the next foreground online
transition authenticates as the old user. Pure-delete ops are the sharp edge: `/sync/push`'s
misroute guard only inspects `op.snapshot?.userId`, and delete ops carry `snapshot: null`, so they
pass the guard and get applied scoped to the *session* user.

**How to apply:** whenever reviewing a "now works offline / local-first" conversion, enumerate every
context that reads the state being written (tab, Service Worker, other tabs), not just the one the
change touched. Ask specifically: which reader has no reconcile hook? Guards that key on a nullable
payload field (`snapshot.userId`) are not a substitute — check whether the null case bypasses them.

Related: [[feedback_sw_postmessage_branch_untested]], [[feedback_concurrency_fix_untested_layer]].
