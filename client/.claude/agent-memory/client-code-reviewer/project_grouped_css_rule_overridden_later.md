---
name: grouped-css-rule-overridden-later
description: A layout fix added as a grouped selector (.a, .b {}) above a class's own rule loses any property the later single-class rule repeats (same specificity, later wins); e2e covers only one of the grouped classes
metadata:
  type: project
---

Seen 2026-11-27 (review wheel-scroll): `.cardScroller, .centeredArea { inline-size: auto; margin-inline: -inset; padding-inline: ... }` placed ABOVE the existing `.centeredArea { inline-size: 100% }`, so centeredArea kept width 100% — with negative margins it ended 2*inset short of the page edge and its card sat inset px off-center from the pinned bar (32px narrower on phones). Only `.cardScroller` had an e2e geometry check, so it shipped green.

**Why:** grouped "share this across N classes" rules get inserted mid-file; authors check the class the bug report named and not its siblings.

**How to apply:** for every grouped selector in a CSS diff, grep each member's other rules in the same file for the same properties; demand a geometry assertion per grouped class (empty-state / missing-routine variants use `.centeredArea`). Verify cheaply with a headless-Chromium setContent repro of the cascade. Related: [[project-e2e-asserts-textcontent-for-visual-bug]], [[project-new-scrollport-leaves-inner-scroller]].
