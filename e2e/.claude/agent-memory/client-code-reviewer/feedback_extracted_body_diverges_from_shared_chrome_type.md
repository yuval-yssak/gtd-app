---
name: extracted-body-diverges-from-shared-chrome-type
description: Editor bodies extracted for a new page route declare an inline `chrome: 'dialog' | 'page'` literal instead of aliasing ItemEditorChrome, and re-implement helpers that already exist in lib/
metadata:
  type: feedback
---

When an existing dialog component is split into `XEditorBody` + `XDialog` to feed a new page route,
two duplications land almost every time:

1. **A private chrome union.** The new body declares `chrome?: 'dialog' | 'page'` inline rather
   than `import type { ItemEditorChrome }` (which `RoutineEditorBody` aliases as
   `RoutineEditorChrome`). Divergence means the shared `shouldAutoFocusTitle(chrome, …)` /
   `bodyClassFor(chrome)` helpers can't be reused, and the autofocus rule gets re-encoded inline
   as `autoFocus={chrome === 'dialog'}`.
2. **A re-implemented lib helper.** New list/order helpers re-declare comparators that already
   exist — e.g. a local `byName` using `localeCompare(…, { sensitivity: 'base' })` when
   `lib/sortByName.ts` exports exactly that, already unit-tested.

**Why:** both landed together in the PersonEditorBody extraction (2026-08-17). The body is small
enough that the duplication reads as harmless, but it means an autofocus/sort-policy change now
has to be made in N places, and CLAUDE.md "Abstraction" explicitly says a pattern appearing 2+
times must be extracted.

**How to apply:** on any `*EditorBody` extraction, check the `chrome` prop's type against
`ItemEditorChrome` and check any new `lib/` sort/filter helper against the existing `lib/` exports
(`sortByName`, `filterItemsByQuery`, `omitArchived`) before accepting it as new code.

Related: [[project_multi_chrome_editor_pattern]]
