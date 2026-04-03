---
name: MUI CSS variable usage — CssVarsProvider now active
description: App switched to CssVarsProvider+extendTheme in __root.tsx; --mui-* CSS vars ARE emitted. Fallbacks on pre-existing vars are now harmless redundancy.
type: feedback
---

The app previously used `createTheme()` with `cssVariables: false` (the default), so `--mui-*` CSS variables were not emitted and any CSS Modules referencing them required hardcoded fallbacks.

**As of the dark-mode branch**, `__root.tsx` switched to `CssVarsProvider` + `extendTheme()`. MUI now emits all `--mui-palette-*`, `--mui-zIndex-*`, and other CSS variables at runtime. The pre-existing fallback values in CSS Modules (e.g. `var(--mui-palette-divider, rgba(0,0,0,0.12))`) are now harmless redundancy rather than safety nets.

**Why:** The dark-mode PR required `CssVarsProvider` so that `useColorScheme().setMode()` works and MUI generates dark-palette CSS variables for `[data-color-scheme="dark"]`.

**How to apply:**
- New CSS Modules written after this change can safely omit fallbacks on `--mui-palette-*` and `--mui-zIndex-*` vars, but including them is still a good practice for defensive coding.
- The z-index fallback rule from the previous memory is relaxed: z-index vars will be present at runtime, but the fallbacks are still recommended for explicitness.
- Do NOT revert to `createTheme()` + `ThemeProvider` — that would silently break dark-mode and the `useColorScheme` hook.
- `calendar.module.css` and `routines.module.css` use `--mui-palette-divider` without a fallback. This was previously a latent bug; it is now correct because the variable is guaranteed to exist.
