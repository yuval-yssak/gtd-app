---
name: percentage-maxheight-against-indefinite-parent
description: Do not suggest min(Nvh, 100%) to tame a viewport-unit cap inside a constrained scroll parent — the percentage resolves to none on indefinite-height ancestors and silently removes the cap
metadata:
  type: feedback
---

When reviewing a `max-height: Nvh` cap that is nested inside an already-scrolling parent, do NOT
recommend `max-height: min(Nvh, 100%)` as the "degrade gracefully" fix.

**Why:** a percentage `max-height` computes against the containing block's height. When that height
is indefinite — which it is on the standalone `/item/:id` page, where `.body` is a flex column and
the `.card` Paper has no height — the percentage resolves to `none`, removing the cap entirely on
exactly the surface the bug was reported on. I proposed this in a round-1 review of the notes-preview
60vh cap; the author correctly rejected it with that reasoning. The accepted resolution was to keep
the plain `vh` cap and treat the nested double-scroll in the weekly-review wizard (`.editorCard` is
`min-height: 0; overflow-y: auto`) as acceptable, since a bounded notes block inside a scrolling card
is strictly better than an unbounded one.

**How to apply:** nested-scroll concerns are still worth raising, but frame them as "verify the
behavior in the constrained host" rather than prescribing a percentage-based cap. If a
containing-block-relative cap really is wanted, the parent needs a definite height (or
`display: flex` + `min-height: 0` on the chain) first — say that instead.

Related: [[feedback_viewport_fitted_page_exposes_latent_fixed_position]],
[[feedback_shared_preview_fix_applied_to_one_host]]
