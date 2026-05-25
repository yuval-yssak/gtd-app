---
name: item-editor-page-mode-parity
description: When adding a feature to ItemEditorBody, page-mode mount in `routes/_authenticated/item.$itemId.tsx` is easily missed — it bypasses useItemEditor and lacks the host Snackbar.
metadata:
  type: feedback
---

ItemEditorBody has four chrome variants. Three of them (dialog, popover, expand) are produced by
`useItemEditor`, which centralises wiring like snackbar feedback, refresh propagation, and
post-save callbacks. The fourth, `chrome="page"`, is mounted directly by
`src/routes/_authenticated/item.$itemId.tsx` — it does NOT go through `useItemEditor`, has no
Snackbar of its own, and only passes the minimum props (item, db, people, workContexts, onClose,
onSaved, chrome, initialStatus).

The pattern that bites: any optional prop added to ItemEditorBody that requires host-level toast
or notification surfaces gets wired through useItemEditor's dialog/popover/expand renderers, plus
the per-route inbox/next-actions/waiting-for/calendar.tsx surfaces — but the page route is
forgotten. The user sees correct behavior on most surfaces and a silent gap on `/item/$itemId`.

**Why:** Concretely surfaced during the fromGmail-readonly snackbar (May 2026). The diff threaded
`onFromGmailReadOnly` through useItemEditor + four routes + EditItemDialog, but the page route
still mounts ItemEditorBody directly without the prop. The route also has no Snackbar mount, so
even if the prop were threaded it would no-op until a host Snackbar landed.

**How to apply:** Whenever a review touches `ItemEditorBody` or adds an optional callback prop:
1. Grep `ItemEditorBody` callers — there are FIVE: EditItemDialog, EditItemPopover,
   EditItemExpand, ProcessInboxWizard, and `routes/_authenticated/item.$itemId.tsx`.
2. The page route is the easy miss because it doesn't go through useItemEditor.
3. ProcessInboxWizard is the second-easiest miss for the same reason — direct mount, custom
   actions API. Acceptable to skip if the feature only fires on transitions that don't apply
   to inbox-clarify (e.g. RSVP, attendee edit, calendar-only side effects).
