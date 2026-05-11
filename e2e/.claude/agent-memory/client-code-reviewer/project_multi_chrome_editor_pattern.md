---
name: Multi-chrome editor refactor pattern (items + routines)
description: Items and routines both use the Body+Expand+Popover+Dialog+useEditor+page-route shape; future entity editors (people, work-contexts) will likely follow it.
type: project
---

The codebase has now standardised on a "multi-chrome editor" pattern for editable entities. The shape is:

- `XEditorBody.tsx` — chrome-agnostic form, owns state + save logic, accepts a `chrome: 'dialog' | 'popover' | 'expand' | 'page'` prop that toggles inline-vs-DialogActions footer + body padding/width.
- `XEditorBody.module.css` — `.body` (default), `.bodyExpand` (with separator + tighter padding), `.bodyPopover` (fixed-ish width), no `.bodyPage` (page wrapper handles its own padding via Paper).
- `XEditorExpand.tsx` — `<Collapse in>` + `<XEditorBody chrome="expand"/>`.
- `XEditorPopover.tsx` — `<Popover>` anchored top-right + `<XEditorBody chrome="popover"/>`.
- `XDialog.tsx` — thin Dialog shell + `<XEditorBody chrome="dialog"/>`.
- `useXEditor.tsx` — host hook that resolves variant from `localStorage['gtd:inlineClarifyMode']`, owns open state, exposes `openEditor / renderGlobal / renderExpandFor`.
- `routes/_authenticated/x.$xId.tsx` — full-page route with `chrome="page"`.

**Why:** The user wants every entity to be editable via the same four surfaces, with the choice driven by a single settings toggle.

**How to apply:** When reviewing a refactor of a new entity editor (people, work-contexts, calendar-integrations, etc.), expect this exact shape. Diverging from it (e.g. defining a custom chrome type per editor) is worth flagging — there's a latent shared `EditorChrome` type that should live in `lib/` rather than being duplicated per editor. Also expect the same gotchas: keyed remount via `key={entity?._id ?? 'new'}`, autoFocus only on dialog chrome, instant mode falling back to dialog when not applicable, mobile fall-through to dialog, no anchor → fall-through to dialog.
