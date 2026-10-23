# Keyboard regions and global shortcuts

Status: **implemented on `exp/keyboard-regions`** (branched from `exp/next-actions-keyboard` at bb6af5f, 2026-10-23); three client
reviewer rounds, Approved on round 3; uncommitted, awaiting human review.

Follow-up to [`next-actions-keyboard.md`](next-actions-keyboard.md): the user had no keyboard way to move between the page's main
sections (the menu, the list, the filters, the account avatars).

## Decisions

- **Regions.** The sidebar menu, the account avatars, the Next Actions filter bar and its list are each ONE tab stop
  (`hooks/useRovingRegion.ts`; the list keeps its own `useNextActionsRovingFocus`). Tab lands on the region, which hands focus to
  the item used last (the menu: always the current page's link, `[aria-current="page"]`); arrows, Home and End walk the items;
  Tab and Shift+Tab leave in one press. The menu walks with ↑/↓, the account avatars with ←/→, the filter chips with all four.
- **No focus state.** The container stays `tabIndex=0`; Shift+Tab takes it out of the tab order for that one keydown only
  (`skipContainerOnShiftTab`). React state on focus re-rendered the page mid-click and dropped clicks; a persisted -1 stranded a
  region whose focused item unmounted (the "+N more" chip, a virtualized row).
- **Global shortcuts** (`lib/globalShortcuts.ts`, `hooks/useGlobalShortcuts.ts`, window capture phase): `g` + letter jumps to a
  page (`GO_TO_TARGETS`, 1.5 s, a hint shows the letters), `?` the legend, `/` the list search, F6 / Shift+F6 cycle the visible
  regions. Consumed keys stop propagating so `g d` on a focused row goes to Done instead of marking the row done. Nothing fires
  in a text field (a checkbox or switch is not one) or under an open dialog — F6 included. Letters are matched by the physical
  key when the layout types non-Latin characters (Hebrew `g` = `ע`).
- **One legend** for the whole app (`components/KeyboardShortcutsDialog.tsx`, opened by `?` or a page's keyboard button).
- The mobile drawer shares the sidebar component and gets the same menu region. No global Escape-to-list: Escape already
  closes dialogs and editors.

## Known limits

- Pages that autofocus a text field (the Inbox capture field) keep letter shortcuts off until focus leaves the field; F6 leaves it.
- Punctuation on a letter key that is not itself a shortcut maps to that key's US letter (Colemak `;` on P acts as `p`).
- Windows AltGr chords (Ctrl+Alt) are treated as modified keys, so `/ ? ,` typed through AltGr do nothing.
- A browser extension that binds `g` or `?` itself (Vimium and similar) sees those keys before the page; the user's own Chrome does.
- Only the Next Actions page has filter and list regions so far; other list pages get the menu, accounts, `g`, `/` and F6.
