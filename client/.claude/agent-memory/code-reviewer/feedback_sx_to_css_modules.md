---
name: MUI CSS variable usage without opt-in
description: When moving sx props to CSS Modules, MUI CSS vars like --mui-zIndex-* require cssVariables:true in the theme
type: feedback
---

When converting MUI `sx` props to CSS Modules, `var(--mui-zIndex-drawer)` and `var(--mui-zIndex-appBar)` are MUI CSS variables that only exist at runtime when `cssVariables: true` is passed to `createTheme()`. This project does NOT opt in to MUI CSS variables.

**Why:** The app uses `createTheme()` with default settings (`cssVariables: false`). MUI's CSS variables (all `--mui-*` tokens) are not emitted to the DOM unless explicitly opted in.

**How to apply:** When reviewing or writing CSS Modules that reference z-index or other MUI tokens, either add a hard-coded fallback (e.g., `var(--mui-zIndex-drawer, 1200)`) or use the raw MUI z-index values directly (appBar=1100, drawer=1200). Flag any `var(--mui-zIndex-*)` usage without a fallback as a critical bug in this codebase.

Pre-existing files already use `--mui-palette-divider` without fallback (acceptable legacy), but z-index is load-bearing (layout break) so it must have a fallback.
