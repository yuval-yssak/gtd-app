---
name: Click-to-edit a11y trap
description: Watch for role="button" wrapping rich/markdown content in the GTD client's editor surfaces — invalid ARIA pattern + content hidden from AT.
type: feedback
---

When reviewing click-to-edit affordances (preview that swaps into a textarea), check three things:

1. The clickable container has `role="button"` AND contains block-level / interactive markdown output (`<p>`, `<a>`, `<h1>`, `<pre>`). WAI-ARIA forbids interactive descendants of `role="button"` — links inside become focus traps; block content makes screen-reader announcement strange.
2. `aria-label` on the container *replaces* its accessible name, so the rendered content (the thing the user wants to read while in preview mode) becomes inaccessible to AT users.
3. Cursor / role mismatch — a `role="button"` with `cursor: 'text'` says one thing visually and another semantically.

**Why:** Came up on the page-mode UX overhaul (notes preview wrapped in `<Box role="button" aria-label="Edit notes"><ReactMarkdown>...</ReactMarkdown></Box>`). All three problems shipped at once.

**How to apply:** When you see `role="button"` near `<ReactMarkdown>` or any rich content, flag as Critical. Recommended fix: separate the gesture from the content (sibling Edit icon-button, or overlay div, or `aria-describedby` instead of `aria-label`).
