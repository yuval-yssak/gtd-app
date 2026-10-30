---
name: render-mirrored-liveness-ref-defeated-by-parent-unmount
description: "isXLiveRef.current = all.some(...)" guards against flush-on-unmount resurrection fail on detail pages whose parent swaps to not-found in the same commit
metadata:
  type: feedback
---

Editor bodies guard flush-on-unmount autosave with a ref mirrored during render (`isPersonLiveRef`, `isContextLiveRef`). On a `/entity/$id` page the parent route looks the row up itself and renders `DetailNotFound` the moment it vanishes, so the body is unmounted WITHOUT a final render — the ref is still `true`, the unmount flush commits the stale snapshot, and an update op resurrects the remotely deleted row (server LWW accepts it). The guard only works in the dialog host, which keeps the body mounted.

**Why:** found in the work-context page review (2026-10-30); the same pattern was ported from PersonEditorBody, so the person page has it too, and no test covered either.

**How to apply:** whenever a body adds a render-mirrored liveness ref, check every host: does any parent stop rendering the body on the same data change? Prescribe an IDB re-read inside commit (`if (!(await db.get(store, id))) return;`) instead, plus a fake-indexeddb component test that deletes the row and unmounts. Related: [[deferred-requeue-dies-with-host-unmount]].
