---
name: react-keys-by-display-name
description: List rows in this UI are repeatedly keyed by display name (chip label, context/person name) instead of a stable entity _id; flag the collision risk.
metadata:
  type: feedback
---

When mapping entity-derived lists to elements (chips, rows), the author tends to key by the human-readable name (e.g. `key={`ctx-${name}`}`) rather than the underlying `_id`.

**Why:** the helpers (`itemContextNames`, `itemPersonNames` in `lib/itemSearch.ts`) return `string[]` of names, throwing away the ids — so the name is the only thing in hand at the call site. People names and work-context names are NOT unique (two contacts named "Dana", two contexts both "@home" across accounts), so duplicate names collide on the same React key → dropped/duplicated chips and reconciliation warnings.

**How to apply:** when you see a `.map(name => <X key={...name...}/>)`, check whether the source could contain duplicate names. Prefer threading the `_id` through the helper return (e.g. `{id, name}[]`) and keying on id. If ids genuinely aren't available, at minimum key on `index` is not better — push back to carry the id. Relates to [[inverse-pair-predicates]] in that the root cause is a lossy helper signature.
