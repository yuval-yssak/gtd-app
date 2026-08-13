---
name: person-ref-expansion-forgotten
description: New code that collects "person ids referenced by an item" repeatedly forgets waitingForPersonId, because peopleIds alone looks complete
metadata:
  type: feedback
---

Whenever a change introduces code that gathers the person ids an item references, check that it
includes BOTH `peopleIds` and `waitingForPersonId`. New call sites reliably ship with `peopleIds`
only.

**Why:** `waitingForPersonId` is a separate scalar field, not folded into `peopleIds`, so the
obvious-looking `item.peopleIds ?? []` reads as complete and passes review by eye. Existing correct
call sites already spell the union out longhand in several places, which means each new one is a
fresh copy-paste opportunity to drop half of it. The failure is silent — a person simply stops
appearing in a chip row or usage ranking, with no error.

**How to apply:** On any diff touching filter facets, usage/ranking indexes, tag resolution, or
"which entities are referenced" logic, grep the new code for `peopleIds` and confirm
`waitingForPersonId` appears alongside it. If the union expression now exists in 2+ places, ask for
it to be extracted into one shared helper rather than fixing the individual site — the duplication is
the actual defect. Same instinct applies to the context side, though `workContextIds` has no
scalar sibling today.

Related: [[collapse-state-vs-shrinking-option-lists]]
