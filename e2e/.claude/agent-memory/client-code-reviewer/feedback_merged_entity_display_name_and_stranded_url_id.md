---
name: merged-entity-display-name-and-stranded-url-id
description: When same-named multi-account entities are collapsed into one UI option, check which twin's name is displayed and what happens when the URL-held twin id stops being visible
metadata:
  type: feedback
---

Whenever multi-account entities are collapsed/merged by normalized name into a single UI
control (filter chip, dropdown option, group header), two things are consistently missed:

1. **Which twin supplies the display label.** Grouping keys are normalized
   (trim + lowercase) but the rendered label is usually taken from an arbitrary group member
   (`twins[0].name`), so casing/whitespace variants make the label non-deterministic from the
   user's point of view. Ask explicitly: is the displayed name a deliberate choice, or an
   accident of sort order?
2. **Stranded URL ids when group membership shrinks.** These features keep one id in the URL and
   expand it to the group at match time. If the account owning the URL-held twin later becomes
   hidden/removed, the id no longer resolves to a group and silently degrades to a singleton —
   the chip renders inactive while the filter is still applied, so the list looks filtered with
   no visible control explaining why. Always trace the "URL id is no longer in any group" path.

**Why:** The merged-filter-chips work on /next-actions surfaced both. Account-visibility
toggling and hidden-account filtering are live features here, so group membership genuinely
changes at runtime — this is not a theoretical edge case.

**How to apply:** On any change that groups entities by name across accounts, verify (a) label
determinism under case/whitespace variants, and (b) the shrinking-group / stranded-id path,
including whether the active-state predicate and the matching predicate can disagree.

Related: [[project_multi_chrome_editor_pattern]]
