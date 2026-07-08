---
name: sw-postmessage-branch-untested
description: SW→tab postMessage branches (new message types) ship without a test and their tab-side receiver trusts event.data as any
metadata:
  type: feedback
---

New `serviceWorker.ts` → open-tab `postMessage` message types tend to ship with **two** untested seams: (1) the SW-side catch/helper that posts the message (e.g. `notifyClientsAccountNeedsReauth` on a background-sync/push 401) has no unit test, and (2) the tab-side `onSwMessage` receiver in `AppDataProvider.tsx` reads `event.data.<field>` with no narrowing — `MessageEvent.data` is `any`, so an untyped field crosses straight into a typed function (a `no any` / CLAUDE.md "TypeScript" hole).

**Why:** SW is awkward to unit-test so authors skip it, and the existing `sync-complete` branch only ever read `event.data.type` so the receiver never needed to narrow a payload field before — the first message type that carries a *payload* (userId) silently inherits the untyped-access pattern.

**How to apply:** On any change adding a SW postMessage type: (a) require a test that mocks `self.clients.matchAll` + rejects the pull/flush with the error and asserts the message is posted; (b) require the receiver to guard `typeof event.data.<field> === 'string'` (or share a typed message interface imported by both ends) before dispatching. Also check the send uses `matchAll({ type: 'window' })` to stay consistent with the `sync-complete` sender. Related: best-effort SW→tab messages self-heal via the next foreground `syncAndRefresh`, so a dropped message (listener not yet attached) is acceptable, but a malformed one dispatching `undefined` is not.
