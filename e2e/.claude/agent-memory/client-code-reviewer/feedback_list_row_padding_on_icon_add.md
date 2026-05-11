---
name: List-row padding regressions when adding secondary-action icons
description: Adding a secondaryAction icon to a list row rarely includes a matching padding-right bump on the row's text class — text overlaps the icon group.
type: feedback
---

When a refactor adds a new icon (CopyIdButton, etc.) to a `<ListItem secondaryAction>` row, the `.listItemText { padding-right }` declaration in the route's `-<page>.module.css` is almost always left at its previous value. With four `size="small"` icons (~24px + ~4px gap each = ~108px ≈ 6.75rem), `padding-right: 3rem` causes visible text overlap on narrower titles.

**Why:** `<ListItem secondaryAction>` is positioned absolute on the right; the only thing keeping the title from sliding under the icons is the text element's right padding. The other list pages (e.g. `next-actions`) use 7.5rem for ~3-4 icons.

**How to apply:** Whenever a PR adds a new icon to a list-row's secondaryAction, look at the corresponding `-<route>.module.css` and check that `padding-right` on the text class accommodates the new icon count. If unchanged, flag it as a layout regression with a concrete suggested value (compare against `-next-actions.module.css` or `-inbox.module.css` as reference points).
