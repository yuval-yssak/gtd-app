---
name: text-folded-into-hover-only-tooltip
description: Space-saving changes that fold visible text into a bare-SVG MUI Tooltip make it hover-only — deleted on the phones the change targets
metadata:
  type: feedback
---

When a screen-real-estate change relocates visible text behind an icon + MUI `Tooltip`, check that
the tooltip child is *focusable*. A bare `<InfoOutlinedIcon data-testid="…"/>` has no tabindex, so
MUI's cloned `onFocus` never fires and there is no touch affordance — the tooltip is mouse-hover
only.

**Why:** these changes are motivated by vertical space, i.e. by phones. So the text ends up
unreachable on exactly the platform the feature was built for — not "folded away" but deleted, plus
a plain a11y regression for keyboard users. The codebase already solved this: `RoutineIndicator.tsx`
wraps its icon variant in a focusable `<button aria-label>` with the comment "wrap in button for
accessible keyboard navigation". The hardened pattern gets bypassed because the new call site is
inside a big component rather than next to the sibling.

**How to apply:** on any `<Tooltip>` whose child is a raw icon/SVG/Typography, require an
`IconButton`/`<button>` wrapper with an `aria-label`. Then reject `toBeVisible()` as coverage — it
passes with an empty `title`. Demand the text itself be asserted through a keyboard path:
`.focus()` then `expect(page.getByRole('tooltip')).toContainText(...)`. Same family as
[[feedback_inline_reimplementation_of_existing_sibling_component]] and
[[feedback_conditional_render_gate_loses_coverage]].
