---
name: inline-reimplementation-of-existing-sibling-component
description: A "add copy-to-clipboard / small affordance" request gets hand-rolled inside the big component, duplicating a hardened sibling that already sits in the same directory
metadata:
  type: feedback
---

When a user asks for a small affordance ("show the item ID and let me copy it"), the change lands as
raw hooks + JSX inside whatever large component is currently in focus (`ItemEditorBody`), even when a
dedicated, hardened component for exactly that job already lives **in the same directory** and is
used by 15+ call sites (`components/itemEditor/CopyIdButton.tsx`).

Two failure modes follow, both silent:
1. **Double affordance.** The hosts that wrap the big component (`EditItemDialog` title,
   `ProcessInboxWizard` header, `item.$itemId` page header) already render the sibling. Adding an
   inline one puts two identical copy buttons on the same screen. Distinct testids mean no existing
   e2e fails.
2. **Dropped hardening.** The sibling handles the clipboard *rejection* path (denied permission,
   unfocused document, insecure context where `navigator.clipboard` is `undefined`) with an explicit
   "Copy failed — select text manually" surface, because silent failure is unacceptable for an
   action the user explicitly asked for. The inline reimplementation is typically
   `void navigator.clipboard.writeText(x).then(setCopied)` — no `.catch`, no sync-throw guard.

**Why:** the author is deep inside the big component's render tree and the affordance feels like two
lines of JSX; the sibling component is never surfaced because nothing in the diff references it.

**How to apply:** before accepting any new inline clipboard / copy / share / tooltip-feedback block,
`grep` the component's own directory and the repo for an existing component doing that job, then
`grep` the *wrapper* call sites to check the new one isn't a second instance on the same screen.

The regression pin that actually works is **role + accessible name**, not testid:
`await expect(dialog.getByRole('button', { name: 'Copy item ID' })).toHaveCount(1)` — scoped to the
editor surface, since list rows behind a dialog legitimately carry their own per-row buttons. A
testid-based assertion cannot catch this class of bug because distinct testids are precisely what
hides it.

Also check the **early-return branches** when consolidating an affordance into a shared body: moving
a copy button from host headers into `ItemEditorBody`'s meta row loses it wherever the body
early-returns (reassign-in-flight) while the host header still renders. Usually an acceptable
trade — but name it explicitly rather than letting it pass unnoticed.
Related: [[extracted-body-diverges-from-shared-chrome-type]].
