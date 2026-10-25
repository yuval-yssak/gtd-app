---
name: feedback-design-system-slice-recurring-gaps
description: Whole-slice DS reviews keep finding the same misses that per-batch reviews pass - braceless guards in small JSX components, tests parked in a sibling's file, kitchen-sink stories, and barrel exports nobody imports
metadata:
  type: feedback
---

Every design-system batch passed its own review, but the 2026-10-25 branch-wide pass still found:
- braceless `if (label === undefined) return control;` guards in 7 components, because each component *looks* short. The rule counts the function's lines, not how small it feels.
- a component's tests living in another component's test file (StepIndicator inside `Badge.test.tsx`), and the same ToggleGroup cases duplicated in `Tabs.test.tsx`.
- "kitchen-sink" stories (`Surfaces`, `Loading`, `Choices`, `Segmented`) that render several components at once. Each one stands in for many per-state stories that don't exist.
- runtime barrel exports and props with zero app consumers (`DialogClose`, `ChoiceLabel`, `endIcon`, `maxRows`, `MenuRoot modal`, ...).
- doc contracts ("props extend ComponentProps", the modal-marker component list) drifting from the code.

**Why:** per-batch reviews look at one component at a time. These gaps only show when every component is compared with its siblings and with `designSystem/CLAUDE.md`.

**How to apply:** for any review that spans more than one DS component:
1. Grep for braceless early exits.
2. Map each component to its own `*.test.tsx` and its stories, one story per state.
3. Grep each barrel export and each optional prop in `client/src` outside `designSystem/` and stories.
4. Re-read the DS CLAUDE.md contract lists against the code.
