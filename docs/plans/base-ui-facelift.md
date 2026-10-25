# Base UI facelift — one-shot migration plan

Status: **decisions answered 2026-10-23 (interview) — ready to execute**. Branch: `feat/base-ui-facelift` off `main`, in its own
worktree (`./scripts/setup-worktree.sh`). **Big-bang by decision**: the branch is unmergeable until
MUI is gone and the full e2e suite is green; nothing ships half-migrated. Each batch below still ends
with the repo checklist green (lint:fix → typecheck → test → `client-code-reviewer`) and waits for
explicit commit approval. Say "execute" in a fresh session — the executor re-reads this file first. There are no open
decisions left; § Interview answers records what was chosen.

**Re-baselined 2026-10-24 against `main` at af20f3c.** The draft was measured at a3274fd; five commits landed on `main`
since (the Next Actions keyboard model, keyboard regions + ranked lists, phone inbox drag, the coding-standards fill-in).
§ Since the draft says what they change for the migration; the ground truth, mapping and batch tables below already
include them.

## What we are building

Replace MUI + Emotion in `client/` with **Base UI (`@base-ui/react`) + typed CSS Modules + a token
file**, and give the app a new look while doing it. The architecture is lifted from
`~/winn-ai/realtime-app` (`src/designSystem/`, its `CLAUDE.md`, `stylelint.config.js`): the value
there is the discipline — cascade layers, semantic tokens, data-attribute variants, a stylelint
gate — not Base UI itself (that repo uses only two Base UI primitives).

Out of scope: anything under `client/src/db/`, `api/`, `data/`, `hooks/` (except the one MUI hook
file), the Service Worker, the API server, the MCP servers. The 7 colour themes are **dropped**
(decision below); light/dark stays.

## Since the draft — `main` a3274fd → af20f3c (2026-10-23/24)

| Commit | What landed | What it means for the facelift |
|---|---|---|
| bb6af5f | Next Actions keyboard model ([`next-actions-keyboard.md`](next-actions-keyboard.md)): roving list focus, keyboard grab in preview order, `NextActionPositionRow` in the editor, per-platform chord labels | The grab/drop keys are implemented against **MUI's non-native buttons**: `useNextActionsRovingFocus.onRowButtonKeyUp` cancels Space on key-up and `useNextActionsDrag.attachKeyboardListeners` stops Enter in the capture phase. A native `<button>` (what Base UI `Button` renders) also clicks on Space key-up / Enter key-down, so both guards **stay**; only their comments change. `NextActionPositionRow` is the only `ButtonGroup` + `FormLabel`/`FormHelperText` user and names its keys through native `title` (a Tooltip wrapper broke the group) — keep `title` there. |
| e469438 | Keyboard regions + ranked lists ([`keyboard-regions.md`](keyboard-regions.md), [`priority-everywhere.md`](priority-everywhere.md) Phase A): `useRovingRegion`, F6 / `g`-jumps / `?` / `/`, `KeyboardShortcutsDialog` + `GoToHint`, `RowActionButton` with shortcut-in-tooltip, `hooks/useRankedList` + `components/rankedList/` shared by Inbox / Someday / Waiting For / Next Actions, editor status letters, legend button in the sidebar | **Hard MUI coupling: `lib/keyboardRegionDom.ts` `isModalOpen()` is `document.querySelector('.MuiModal-root:not([aria-hidden="true"]))`** — every global shortcut, F6 and row letter is gated on it (decision § Modal-open marker). `isRegionShown` relies on MUI's keep-mounted drawer being `aria-hidden` + `visibility: hidden` while closed; the Base UI Drawer unmounts when closed, so the mobile menu region simply leaves the DOM — never pass `keepMounted` to it. `KeyboardShortcutsDialog` is the only MUI `Table` user (+ a "plain element because a module rule loses to Emotion" workaround that the layer order makes unnecessary). `GoToHint` is a `Paper elevation={6}` at `--mui-zIndex-snackbar` → `--shadow-popup` + `--z-toast`. The legend button lives in `AppNav`'s drawer brand row; the sidebar is a roving region keyed on TanStack's `aria-current="page"` (survives). The tooltip text contract `"Edit (e)"` (`lib/rowShortcuts.ts` `withShortcutHint`) and `aria-keyshortcuts` must survive onto the DS `IconButton`. |
| bbd81f6 | Phone inbox rows drag via the shared long-press handle; swipe gesture moved into `lib/swipeTracker.ts` | MUI-free logic, but the swipe row is a MUI `ListItem` and `e2e/ranked-lists.spec.ts` reads its transform through `.MuiListItem-root` — give the swipe row a test id when batch 4 converts `inbox.tsx`. `inbox.tsx` also hosts the "Move to…" `SwipeableDrawer` (bottom sheet) → DS `Drawer` (bottom side) or `Dialog`. |
| 9b3c718 | Coding standards filled in from the Winn skills: root `CLAUDE.md` (TDD / layered coverage / mock-boundaries-only, lint suppressions, Logging, same-change registries) and `client/CLAUDE.md` (CSS/Styling + Storybook sections) | `client/CLAUDE.md` § CSS/Styling now **codifies the MUI era**: design decisions in the MUI theme, `:global(.Mui*)` in module selectors, `--mui-palette-*` / `index.css` variables, the `.cls.cls` outspecify idiom, `classnames`, "the wrapped MUI component's props". Phase 0.8 rewrites that section for the DS (tokens file, data-attribute variants, `clsx`, Base UI part props, layers instead of outspecifying); the parts that already match the DS rules — typed CSS Modules, static-vs-dynamic split, never `!important`, `rem` not `px` with the hairline exception, no literal z-index — stay and are now also enforced by stylelint. The new § Storybook ("every state a story", `beforeEach` not `decorators`, play-function patterns) and § Tests (test-first, "untested legacy code: pin first") apply to every DS component in Phase 0.5. |
| af20f3c | Merge of `origin/main` into `exp/keyboard-regions`, now `main` | Branch point for `feat/base-ui-facelift`. |

**Branch hygiene.** `main` moved by ~7k lines two days after the draft. The facelift branch rebases onto `main` after **every**
batch, not at the end; the conflict hot spots are the list routes (`inbox`, `someday`, `waiting-for`, `next-actions`),
`components/rankedList/`, `AppNav` and `ItemEditorBody`, all of which the keyboard work just rewrote.
[`priority-everywhere.md`](priority-everywhere.md) Phase B (ranks on routines / people / work contexts) is undecided and would
touch the batch 7 and 8 pages plus the pickers: land it **before** the facelift branch starts or **after** it merges, not during.

## Decisions this plan is built on

| Topic | Decision |
|---|---|
| Migration shape | **One go.** MUI and the DS do not coexist on `main`; inside the branch they coexist only between batches. No per-route feature flag. |
| Colour themes | **Dropped.** `lib/colorTheme.ts` `COLOR_THEMES`/`buildThemeOptions` and the Settings picker go; `tests/colorTheme.test.ts` is rewritten for the scheme toggle only. localStorage key `gtd:colorTheme` is left unread (harmless). |
| Light/dark | Three-state **system / light / dark** toggle in Settings, as today. Stamp `data-theme="light\|dark"` on `<html>` from a tiny `lib/colorScheme.ts` (pattern: realtime-app `designSystem/colorTheme.ts` `applyColorTheme`), resolving `system` via `matchMedia('(prefers-color-scheme: dark)')` with a change listener. `color-scheme` is bound to the stamp in the reset so native controls/scrollbars follow. Attribute, not media query, so the manual toggle works. |
| Look | Neutral grey ramp + **one blue accent** at today's `#1976d2` so the app still reads as itself; **hairline borders, no elevation shadows** (popups get the single `--shadow-popup` token); **Inter** via `@fontsource/inter` (replaces Roboto 300/400/500/700 in `main.tsx`); **density unchanged** (row heights, paddings and touch targets keep today's values so the `weekly-review-card-fits` geometry specs stay meaningful); 4px spacing scale; radius 8px controls / 12px cards+dialogs; type ramp 12/14/16/20/24; focus ring = solid 2px accent at 2px offset everywhere. |
| Icons | **`lucide-react`** (chosen over Material Symbols / Phosphor), tree-shaken named imports. The 69 `@mui/icons-material` glyphs get a one-time mapping table in the plan executor's notes (not in code); `@mui/icons-material` cannot stay because it pulls `@mui/material` → Emotion. |
| Styling API | Typed CSS Modules (`typed-css-modules` already in the build). Variants/booleans are **data attributes** (`data-variant="ghost"`, `data-selected={flag \|\| undefined}`); never class-name maps, never `sx`/`style` props. `className` merged last via `clsx` — `classnames` (10 files) is replaced and removed. |
| Cascade | `@layer gtd.tokens, gtd.base, gtd.components, gtd.composites, gtd.overrides;` declared ONCE in `designSystem/tokens/base.css`. Basic components in `gtd.components`, composites in `gtd.composites`, so a composite styling a nested basic always wins without specificity games. Unlayered consumer CSS beats all layers → no `!important` ever. |
| Tokens | `designSystem/tokens/variables.css`: `--color-*` semantic tier (`bg-page`, `bg-surface`, `bg-surface-raised`, `border-default`, `border-strong`, `divider`, `text-primary`, `text-secondary`, `text-disabled`, `accent`, `accent-hover`, `accent-tint-bg`, `on-accent`, `status-error/-warning/-success/-info` + `-tint-bg` each, `state-hover`, `state-selected`, `state-focus`), `--space-1…12`, `--radius-sm/md/lg/full`, `--type-{xs,sm,md,lg,xl}-{size,line}`, `--font-sans`, `--font-mono`, `--z-{app-bar,drawer,dialog,popup,toast}`, `--breakpoint-sm/md` (documented values; media queries cannot read vars so the `useIsMobile` hook and CSS share a literal with a comment). Light values on `:root`, dark on `:root[data-theme="dark"]`; 8-digit hex for alpha (no `color-mix` — WebKit PWA). |
| Stylelint gate | Copy realtime-app `stylelint.config.js` wholesale, rename nothing but paths; covers every `src/**/*.module.css` plus `designSystem/tokens/*.css` (`index.css` is absorbed into the reset in Phase 0). Bans raw colours, physical properties, `!important`, literal z-index, element selectors in component modules, literal `font-size` in app CSS. `npm run lint` gains `lint:css`. |
| Import ban | Biome `noRestrictedImports` for `@mui/*`, `@emotion/*`, `classnames` — added in **Phase 3 only** (it would fail the build mid-branch). Copy the rule shape from `~/winn-ai/realtime-app/biome.jsonc`. |
| Base UI version | `@base-ui/react@1.7.0` pinned (same as realtime-app). Animation contract: `data-starting-style` / `data-ending-style`; Collapsible height via `--collapsible-panel-height`. Portals go to `document.body` (the body is ours — no `PortalTargetProvider` needed). |
| Breakpoint hook | One `hooks/useIsMobile.ts` (`matchMedia`, `useSyncExternalStore`) replaces the 8 `useTheme()+useMediaQuery(theme.breakpoints.down('md'))` pairs. Base UI's `unstable_useMediaQuery` is NOT used (unstable). |
| Toasts | One `Toast.Provider` mounted in `__root.tsx`; `useToast()` hook; replaces 18 `Snackbar` sites incl. `UndoSnackbar` (action button survives). Position: bottom-centre on mobile, bottom-left on desktop. Auto-dismiss 5s, undo toasts 8s (today's values, keep whatever each site uses). |
| Dialogs | One DS `Dialog` (Root/Trigger/Popup/Title/Description/Actions/Close) over Base UI Dialog, **centred card on every screen size — no full-screen-under-md variant**. `AlertDialog` for the confirmations (group C below). Keep `role="dialog"` + `aria-labelledby` — 58 e2e `getByRole('dialog')` queries depend on it. |
| **Editor modes → Full Page only** | The Settings "Item editor" radio (`dialog` / `expand` / `popover` / `instant` / `page`, `lib/clarifyMode.ts`, key `gtd:inlineClarifyMode`) is **deleted**; `page` is the only behaviour. Removed with it: `EditItemDialog`, `EditItemPopover`, `EditItemExpand`, `RoutineDialog`, `RoutineEditorPopover`, `RoutineEditorExpand`, the `resolveVariant` branches in `useItemEditor.tsx` / `useRoutineEditor.tsx`, the inbox "Instant" chip behaviour, and `ProcessInboxWizard`'s dialog chrome (`batchChromeFor` → always `/process-inbox`). "Move in progress" (reassign in flight) renders inline on the item/routine page (`ReassignInFlightInline` already exists). Unknown stored mode values are simply ignored. Weekly Review cards **keep** rendering `ItemEditorBody` inline — that is a card, not an editor mode. |
| Remaining popups (interview groups) | **B — short forms** (Add/Edit person, Save as person, Add/Rename work context, Quick capture, Your inboxes, Create API token + Token created, Rename device, Add/Choose calendar): centred `Dialog`, same on all sizes. **C — confirmations** (Discard unsaved changes, Delete routine, Pause routine, Delete account, Remove device, Revoke token, Disconnect Google Calendar, Detach this occurrence, Send update emails): `AlertDialog`. **D — system notices** (Full sync required, Sync is broken, Sync issues panel): stay modal `Dialog`; "Inbox clear!" becomes a toast. **E — anchored popups** (account menu, search row menu, `DatePickerPopover`, Select/Combobox dropdowns, tooltips): stay anchored via Base UI Menu/Popover/Select/Combobox on every size. |
| Drawer / mobile shell | Base UI **Drawer** (present in 1.7: `node_modules/@base-ui/react/drawer`) replaces `SwipeableDrawer` + `Drawer` in `AppNav.tsx`/`_authenticated.tsx`. Phase 0 includes a 30-minute spike proving swipe-to-close on iOS Safari; **if it fails, fall back to a `Dialog`-based side sheet with no swipe** (closes via scrim tap / close button). |
| Pickers | `Autocomplete` (`itemEditor/MeetingDetails.tsx`) → Base UI `Combobox`. `Select` (3) → Base UI `Select`. `Tabs` (4) → Base UI `Tabs`. `Stepper` (`WeeklyReviewWizard`) → hand-rolled `StepIndicator` (no Base UI part). `Accordion` (1) → Base UI `Accordion`. `Fab` → DS `Button variant="fab"`. `DatePickerPopover` is kept (re-skinned over Base UI Popover). |
| Tooltips | Base UI Tooltip is hover/focus only (no long-press). Every icon-only button gets `aria-label` **and** the DS `IconButton` renders a `title` fallback; information conveyed only by a tooltip gets a visible label on mobile. Audit per batch. **Shortcut hints**: the DS `Tooltip` renders `role="tooltip"`, opens on hover/focus with a delay no longer than today's MUI default, closes on leave, and shows exactly the `withShortcutHint` text (`"Edit (e)"`) — `e2e/row-shortcut-tooltips.spec.ts` and `ranked-lists.spec.ts` assert it on every list. A tooltip on a **disabled** control (the editor's Save button, `ItemEditorBody`) needs the DS `Tooltip` to accept a disabled trigger (wrapper span or `title` fallback) — Base UI's trigger gets no pointer events from a disabled button either. |
| **Modal-open marker** | Every DS popup that must block page shortcuts underneath it — `Dialog`, `AlertDialog`, `Drawer`, `Menu`, `Popover`, `Select`/`Combobox` popups — renders `data-modal-popup` on its Popup element. `lib/keyboardRegionDom.ts` `isModalOpen()` becomes `document.querySelector('[data-modal-popup][data-open]') !== null` (Base UI stamps `data-open`; a closed popup is unmounted unless `keepMounted`, which the DS never sets). During the branch it is the **union** with today's `.MuiModal-root:not([aria-hidden="true"])` so F6, `g`-jumps and row letters stay gated while both systems coexist; the MUI half goes in Phase 2. `e2e/keyboard-regions.spec.ts` (shortcuts inert under a dialog, F6 included) is the proof; the jsdom test covers the DS side in Phase 0.5, and the spec runs from batch 1 on, the first batch that renders a DS dialog in the app. |
| Typography | `Typography` (54 sites) → semantic elements + `--type-*` tokens via a tiny `Text` component (`as`, `size`, `tone`) to keep call sites short; headings are real `h1–h6` (30 e2e `getByRole('heading')`). |
| Layout prims | `Box` (63) / `Stack` (13) / `Paper` (22) → plain `div` + module classes, or DS `Stack`/`Card` when the pattern repeats ≥2×. No generic `Box` replacement — that is how `sx` sneaks back. |
| CodeMirror | Editor theme must read the new tokens (`--color-*`) instead of MUI vars; dark mode follows `data-theme`. |
| Storybook | `.storybook/preview.tsx` drops `CssVarsProvider`; imports `tokens/base.css`; adds a "Theme" toolbar global stamping `data-theme` (realtime-app decorator pattern). Every DS component gets a story; `addon-a11y` stays. |
| Public pages | Landing, `/terms`, `/privacy` are **restyled with the DS**; content, app name "Done", links and the sign-in flow stay byte-identical so the Google OAuth homepage approval (2026-10-02) is not disturbed. |
| Fonts offline | Inter woff2 is picked up by the existing `injectManifest.globPatterns` (`woff2` included) — verify in the built precache manifest, do not assume. |

## Ground truth (measured 2026-10-24 at af20f3c — do not re-derive)

| Measure | Value |
|---|---|
| Files to touch (`@mui/` import or `var(--mui-…)`) | **161** (119 .tsx/.ts + 41 .module.css + 1 .css); was 151 at a3274fd |
| Distinct MUI modules | 145 (70 icons, ~75 components) — the keyboard work added `ButtonGroup`, `FormHelperText` and the `KeyboardOutlined` icon; `Table*` was already in use |
| `sx=` props | 274; `styled()` 0 |
| `useTheme`/`useMediaQuery` pairs | 8, all "is mobile" |
| `Snackbar` sites | 19 · `Dialog` 23 · `Tooltip` 26 · `Chip` 30 · `TextField` 27 · `Button` 52 · `IconButton` 35 |
| Existing CSS Modules | 68, 41 of them reference `--mui-*` (divider, text-secondary, primary-main, error-main, plus `--mui-shadows-4` / `--mui-palette-background-paper` on the ranked-list drag ghost and `--mui-zIndex-snackbar` on `GoToHint`) |
| e2e specs | 126; **6** use `.Mui*` selectors (15 occurrences): `edit-item-cross-account-calendar-picker` (`.MuiFormControl-root`), `item-editor-page-mode` + `unsaved-changes-guard` (`.MuiModal-root:not([aria-hidden])` → no open dialog), `list-page-autofocus` (`.MuiTypography-subtitle2` group headers), `keyboard-regions` (`.MuiDialog-root` focus check), `ranked-lists` (`.MuiChip-root` + `MuiChip-filled` ×8 for the editor status chips, `.MuiListItemText-primary span:first-child` row titles, `.MuiListItem-root` swipe transform) |
| e2e role queries | button 233 · textbox 130 · dialog 58 · heading 30 · link 26 · checkbox 11 · option 6 · menuitem 6 · progressbar 4 · tooltip 3 |
| Client unit tests referencing MUI | 0. **No DOM test environment exists**: `vitest.config.ts` runs in `node`, neither `jsdom`/`happy-dom` nor `@testing-library/react` is installed, and the existing `.tsx` tests walk React elements without rendering (`nextActionsRowTags.test.tsx`). `lib/keyboardRegionDom.ts` is e2e-only for that reason. The DS render tests in Phase 0.5 need 0.1 to add the environment, opted into per file with `// @vitest-environment jsdom` so the rest of the suite stays in `node` |
| Stories | 16 |
| Theming today | `__root.tsx` `CssVarsProvider` + `extendTheme(buildThemeOptions(id))`, `CssBaseline`; `data-color-scheme` attribute on `<html>`; `index.css` has `--gtd-*` vars keyed on `[data-color-scheme="dark"]`; Settings uses `useColorScheme()` |
| Files by directory | `components/` 43 · `routes/_authenticated/` 28 · `components/weeklyReview/` 16 · `components/itemEditor/` 11 · `routes/` 10 · `components/settings/` 9 · `routines/` 6 · `pickers/` 6 · `search/` 5 · `routineEditor/` 5 · `clarify/` 5 · `markdown/` 4 · `rankedList/` 3 · `people/` 3 · `quickCapture/` 2 · `nextActions/` 2 · `hooks/` 1 · `contexts/` 1 · `workContexts/` 1 |
| Base UI 1.7 roster (from realtime-app `node_modules`) | accordion alert-dialog autocomplete avatar button checkbox checkbox-group collapsible combobox context-menu dialog drawer field fieldset form input menu menubar meter navigation-menu number-field otp-field popover preview-card progress radio radio-group scroll-area select separator slider switch tabs toast toggle toggle-group toolbar tooltip |

Repo rules that bite here: `npm run generate-typed-css-modules` after every `.module.css` edit;
Biome owns formatting (never hand-fix); `hasAtLeastOne` over `.length > 0`; `dayjs` only; stop hook
runs client+e2e checks after each turn. Since 9b3c718 the standards are explicit about things this
branch does all day: **tests and stories come first** (root `CLAUDE.md` § Tests: write the DS
component's story + render test, watch it fail, then implement; "untested legacy code: pin first"
applies to `lib/keyboardRegionDom.ts`, which is e2e-covered only, before `isModalOpen` is rewritten);
layered coverage is mandatory (unit + integration + e2e + story, not alternatives); `vi.mock` on a
sibling module is a design smell; a `biome-ignore` needs the rule name and the reason on one line;
`client/CLAUDE.md` § Storybook wants a story per **state**, arranged in `beforeEach`, and a
reproducing story for every visual bug fixed along the way.

## MUI → DS mapping

| MUI | DS component (`client/src/designSystem/`) | Built on | Layer |
|---|---|---|---|
| Button, ButtonBase, Fab, LoadingButton-ish | `Button` (`variant` solid/outline/ghost/fab, `tone` accent/neutral/danger, `size`, `loading`) | Base UI Button | components |
| IconButton | `IconButton` (requires `aria-label`; `title` fallback) | Base UI Button | components |
| Chip | `Chip` (`selected`, `onDelete`, `tone`) | span / Base UI Button when clickable | components |
| Typography | `Text` (`as`, `size`, `tone`, `weight`) | element | components |
| TextField, InputAdornment, InputLabel, FormControl, FormControlLabel, FormLabel, FormHelperText | `Field` (Root/Label/Control/Description/Error) + `Input`, `Textarea`, `InputAdornment` slot | Base UI Field/Input | components |
| Switch / Checkbox / Radio+RadioGroup | `Switch`, `Checkbox`, `RadioGroup` | Base UI | components |
| Select / MenuItem (in Select) | `Select` | Base UI Select | components |
| Tooltip | `Tooltip` | Base UI Tooltip | components |
| Divider | `Separator` | Base UI Separator | components |
| CircularProgress / LinearProgress / Skeleton | `Spinner`, `ProgressBar`, `Skeleton` | Base UI Progress / CSS | components |
| Badge / Avatar | `Badge`, `Avatar` | span / Base UI Avatar | components |
| Alert | `Callout` (`tone`) | div | components |
| Paper / Card-ish surfaces | `Card` | div | composites |
| Stack / Box | plain elements; `Stack` only if the gap pattern repeats | — | — |
| List, ListItem, ListItemButton, ListItemText, ListItemIcon, ListSubheader | `List` (Root/Item/ItemButton/Subheader) — keep `ListRowShell` as the row primitive | ul/li/Base UI Button | composites |
| Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions (groups B + D) | `Dialog` | Base UI Dialog | composites |
| Confirm dialogs (group C) | `AlertDialog` | Base UI AlertDialog | composites |
| Menu, MenuItem, Popover | `Menu`, `Popover` | Base UI | composites |
| Snackbar | `Toast` provider + `useToast` | Base UI Toast | composites |
| Tabs/Tab | `Tabs` | Base UI Tabs | composites |
| Collapse / Accordion | `Collapsible`, `Accordion` | Base UI | composites |
| ToggleButtonGroup/ToggleButton | `ToggleGroup` | Base UI ToggleGroup | composites |
| ButtonGroup (`NextActionPositionRow` only) | `ButtonGroup` (`role="group"` wrapper that joins DS `Button`s; children keep their native `title`) | div | components |
| Table/TableBody/TableRow/TableCell (`KeyboardShortcutsDialog` only) | plain `<table>` + a module in the dialog — no DS component for one site | — | — |
| Autocomplete | `Combobox` | Base UI Combobox | composites |
| Drawer / SwipeableDrawer / AppBar / Backdrop | `Drawer`, `AppBar` | Base UI Drawer / header | composites |
| Stepper | `StepIndicator` | hand-rolled | composites |
| CssBaseline | `tokens/base.css` reset (absorbs today's `index.css`) | — | base |
| `useMediaQuery` | `hooks/useIsMobile.ts` | matchMedia | — |
| `useColorScheme` | `lib/colorScheme.ts` | matchMedia + `data-theme` | — |

## Phase 0 — foundation (no screen changes; MUI still renders)

0.1 Deps: add `@base-ui/react@1.7.0`, `clsx`, `lucide-react`, `@fontsource/inter`, dev
`stylelint`, `stylelint-config-standard`, and — new since the re-baseline found none — `jsdom` +
`@testing-library/react` + `@testing-library/user-event` for the DS render tests and the
`isModalOpen` test (per-file `// @vitest-environment jsdom`; `vitest.config.ts` stays `node`). Do **not** remove MUI yet.

0.2 `designSystem/tokens/{variables,base}.css` (layer order declared once; reset absorbs
`index.css`: rem down-scaling media queries, `100dvh` body, scrollbar styling, `.dbUpgradeBlockedNotice`,
`--gtd-notes-max-height` → renamed `--notes-max-height`). `main.tsx` imports `tokens/base.css`
**before** MUI so MUI's own styles still win during the branch; `index.css` deleted at the end of
Phase 0 once nothing references it.

0.3 `lib/colorScheme.ts` (`getColorSchemePreference`, `setColorSchemePreference`, `useColorScheme`,
`applyColorScheme`) stamping `data-theme`. During the branch, **also** keep MUI's
`data-color-scheme` in step (one line in `__root.tsx`) so both systems agree; removed in Phase 3.
Unit test: system→dark resolves via matchMedia mock; manual override wins; cross-tab storage event.

0.4 `stylelint.config.js` + `lint:css` script + wire into `lint`. Until Phase 2 the gate runs on
`designSystem/**` only: existing modules carry raw colours and physical properties that each Phase 1
batch fixes as it converts the directory, and the glob is widened to `src/**` in Phase 2.

0.5 DS components from the mapping table, each with: `.tsx`, `.module.css` (+ generated d.ts),
`.stories.tsx` (light+dark via the Theme global), a Vitest render test for a11y-critical behaviour
(Dialog focus trap / `aria-labelledby`, AlertDialog `role="alertdialog"`, Toast `role`, IconButton without `aria-label` throws in dev).
Order: Text → Button/IconButton → Field/Input → Chip → Switch/Checkbox/RadioGroup → Separator →
Tooltip → Dialog/AlertDialog → Menu/Popover → Toast → Tabs → Collapsible/Accordion → Select →
Combobox → ToggleGroup → ButtonGroup → List → Card/Callout/Badge/Avatar → Spinner/ProgressBar/Skeleton →
Drawer/AppBar → StepIndicator.

Alongside Dialog/AlertDialog: the `data-modal-popup` marker on every modal Popup (decision § Modal-open
marker), `keyboardRegionDom.isModalOpen()` switched to the **union** selector with a jsdom test that
pins today's MUI case first and then adds the DS case, and a `.srOnly` utility in `tokens/base.css`
(`gtd.base`) so `RankedList.module.css` and friends stop carrying their own `1px` visually-hidden
rules (the stylelint `px` rule would flag them). Native-button behaviour of the DS `Button` is part of
the Button render test: Space key-up and Enter key-down click, which is what the grab-mode guards in
`useNextActionsRovingFocus` / `useNextActionsDrag` keep suppressing.

0.6 **Drawer spike** (decision 3): a story + a manual check on iOS Safari for swipe-to-close and
`position: fixed` behaviour under the PWA chrome.

0.7 `hooks/useIsMobile.ts` + test. `.storybook/preview.tsx`: import `tokens/base.css`, add the
Theme toolbar global, and keep the MUI `CssVarsProvider` wrapper beside it only while the 16
existing stories still render MUI components; it is dropped in Phase 2.

0.8 `designSystem/CLAUDE.md` (adapted from realtime-app's) + a `client/CLAUDE.md` section
"Design system" + root `CLAUDE.md` tweaks (Post-Change Checklist gains `lint:css`; the "React
19/MUI" wording in agent descriptions and `client/.claude/agents/code-reviewer.md` updated).
`client/CLAUDE.md` § CSS/Styling (rewritten by 9b3c718 for the MUI era) is rewritten again here,
rule by rule: "design decisions live in the MUI theme" → the token file + DS components; the
`:global(.Mui*)` rule → gone (every part is our own DOM, variants are data attributes); colours and
z-indexes → `--color-*` / `--z-*` from `designSystem/tokens/variables.css` (never `index.css`, which
no longer exists); the `.cls.cls` outspecify idiom → unnecessary, unlayered consumer CSS beats
`@layer gtd.*`; `classnames` → `clsx`; "the wrapped MUI component's props" → the Base UI part's
props. The rules that already fit the DS (typed modules, static-vs-dynamic split, never
`!important`, `rem` not `px` with the hairline exception, no centring hack) are kept and cross-referenced
to the stylelint config that now enforces them. § Storybook keeps every rule; its one MUI mention
(`.storybook/preview.tsx` mirrors the theme) becomes "imports `tokens/base.css` and stamps the Theme
global". Until this lands, the branch is **deliberately violating** the committed `client/CLAUDE.md`
— the reviewer must be told which file is authoritative in every Phase 0/1 prompt.

Reviewer pass on Phase 0 as a whole before Phase 1 starts.

## Phase 1 — migrate screens, batch by directory (MUI shrinking)

Each batch: convert every file in the directory (tsx **and** its `.module.css` `--mui-*` refs),
replace `classnames`→`clsx`, map icons, audit Tooltip-only information, run checklist + reviewer,
run the e2e specs that cover that surface (`npx playwright test <specs>`), get commit approval.
Batches are ordered so shared pieces land before their consumers:

| # | Batch | Files | Notes |
|---|---|---|---|
| 1 | shell: `routes/__root.tsx`, `_authenticated.tsx`, `components/AppNav*`, `StatusBar`, `NavigationProgress`, `AccountChip/Picker/Switcher/SyncChip/Avatar`, `AccountReauthBanner/Dialog`, `GlobalShortcuts`, `KeyboardShortcutsButton`, `KeyboardShortcutsDialog` (+ its `Table`), `GoToHint` | ~18 | `__root` keeps `CssVarsProvider` until Phase 3 but mounts `Toast.Provider` now. `AppNav`: the DS `Drawer` replaces only the temporary (mobile) drawer; the permanent one is a plain `<nav>`; `DrawerContent` (menu region, legend button, brand row) is shared by both. `AccountSwitcher` keeps `role="toolbar"` + its region props on the DS `Menu` trigger. e2e: `keyboard-regions.spec.ts` (menu/accounts regions, F6, `?` legend, shortcuts inert under the DS dialog), `row-shortcut-tooltips.spec.ts` (`keyboardShortcutsButton` tooltip) |
| 2 | list primitives: `ListRowShell`, `ListSearch`, `ListSkeleton`, `CalendarRowMeta`, `RoutineIndicator`, `ArchivedItemsView`, `CopyButton`, `RowActionButton`, `UndoSnackbar`, `SyncingChip`, `SyncIssuesPanel`, `SyncRecoveryDialog`, `NotificationNudge`, `AppErrorBoundary`, `RouteFallback`, `components/rankedList/` (`RankedListChrome` Snackbar → toast, `RankedRowHandle` IconButton, `RankedList.module.css` drag ghost → `--shadow-popup` + `--color-bg-surface-raised`, `.srOnly` → base utility) | ~20 | the facelift is most visible here. `RowActionButton` / `RankedRowHandle` spread `rowActionButtonProps` (`data-row-action`, `aria-keyshortcuts`) and `tabIndex=-1` onto the DS `IconButton` — it must pass unknown props through to the button. e2e: `row-shortcut-tooltips.spec.ts`, `ranked-lists.spec.ts`, `next-actions-keyboard.spec.ts`, `next-actions-reorder-mobile.spec.ts` |
| 3 | **Editor modes → page only** (feature removal, done *before* restyling the editor so the restyle touches fewer files): delete `lib/clarifyMode.ts`, `EditItemDialog*`, `EditItemPopover`, `EditItemExpand`, `RoutineDialog`, `RoutineEditorPopover`, `RoutineEditorExpand`, `RoutineEditorDialog.module.css`; simplify `useItemEditor.tsx` / `useRoutineEditor.tsx` to `page` / `newTab` / in-flight; `ProcessInboxWizard.batchChromeFor` → always navigate to `/process-inbox`; Settings "Item editor" section removed; inbox "Instant" chip path removed. e2e: delete `item-editor-modes.spec.ts`, `routine-editor-modes.spec.ts`; strip the mode set-up from `item-editor-page-mode`, `process-inbox-wizard`, `list-scroll-restoration`, `calendar-mark-done`, `helpers/login.ts`; add a spec asserting the chip click on every list page lands on `/item/:id` and that Settings no longer offers the radio. | ~16 + 7 specs | pure deletion; MUI still renders what remains |
| 3b | `components/pickers/` + `components/clarify/` + `components/itemEditor/` (incl. `MeetingDetails` Combobox + Detach AlertDialog, `SendUpdatesDialog` AlertDialog, `BriefSection` toast, the Save-button tooltip on a disabled control) + `components/nextActions/NextActionPositionRow` (ButtonGroup, native `title`s) + `components/markdown/` (CodeMirror theme tokens) | ~23 | editor is shared by the item page and the Weekly Review. `useEditorShortcuts` gates on `e.currentTarget.contains(e.target)` (editor's own DOM, not a MUI class) — survives, but the DS `Select`/`Menu` popups must still portal **outside** the editor root or typing `w` in an open Select would switch the status. The status-chip letters and `Cmd/Ctrl+Enter` are asserted by `ranked-lists.spec.ts`, which today reads `.MuiChip-root` + `MuiChip-filled` for the selected state → DS `Chip` `data-selected` + a test id, rewritten in the same batch. `ItemEditorBody`'s "other chromes get ESC from MUI Modal" comment dies with batch 3. e2e: `ranked-lists.spec.ts`, `item-editor-autosave.spec.ts`, `item-editor-page-mode.spec.ts` |
| 4 | list routes: `inbox`, `next-actions`, `waiting-for`, `someday`, `tickler`, `calendar`, `done`, `trash`, `search` + `components/search/` | ~14 | 7 `useIsMobile` swaps. `inbox.tsx` hosts the "Move to…" `SwipeableDrawer` bottom sheet (→ DS `Drawer`, bottom side, or `Dialog`), `Tabs`, and the phone swipe rows (give the swipe row a test id; `ranked-lists.spec.ts` reads its transform via `.MuiListItem-root` and the row title via `.MuiListItemText-primary`). The four ranked routes share `useRankedList` + `rankedList/` from batch 2, so each is mostly `List`/`Chip`/`Typography` swaps; keep every `data-keyboard-region`, `data-roving-item`, `data-list-search-*` and `data-item-id` attribute exactly where it is. e2e: `ranked-lists.spec.ts`, `next-actions-keyboard.spec.ts`, `keyboard-regions.spec.ts`, `list-page-autofocus.spec.ts` (`.MuiTypography-subtitle2` → heading role) |
| 5 | `item.$itemId`, `process-inbox` + `ProcessInboxWizard` (page chrome only; "Inbox clear!" → toast), `components/quickCapture/` (Add to inbox stays a centred Dialog) | ~5 | |
| 6 | `components/weeklyReview/` + `weekly-review.tsx` | ~17 | `WeeklyReviewWizard` Stepper → StepIndicator; card-fit geometry e2e (`weekly-review-card-fits`) has pre-existing failures under the fake brief — record baseline first |
| 7 | routines: `components/routines/`, `routineEditor/`, `routines.tsx`, `routine.$routineId.tsx` | ~13 | |
| 8 | people/contexts: `components/people/`, `workContexts/`, `people.tsx`, `person.$personId.tsx`, `work-contexts.tsx` | ~7 | |
| 9 | `components/settings/` + `settings.tsx` (37 `sx`, colour-theme picker **removed**, "Item editor" radio already gone in batch 3, scheme toggle rewired to `lib/colorScheme.ts`) + `contexts/PendingReassignProvider` + `hooks/useHiddenAccountCaptureNotice` | ~12 | densest MUI user, least traffic — last |
| 10 | public routes: `index`, `-LandingPage`, `login`, `auth.callback`, `terms`, `privacy`, `-LegalPage` | ~7 | landing page is Google-OAuth-reviewed — keep the same content and the app name "Done" |

After batch 10: `grep -rE "@mui/|--mui-|classnames" client/src` must return nothing.

## Phase 2 — remove MUI

- Uninstall `@mui/material`, `@mui/icons-material`, `@emotion/react`, `@emotion/styled`,
  `@fontsource/roboto`, `classnames`. Delete `lib/colorTheme.ts` remnants + its test, the
  `data-color-scheme` bridge, the Storybook MUI wrapper, and the `.MuiModal-root` half of
  `keyboardRegionDom.isModalOpen()` (its jsdom test drops the MUI case; `keyboard-regions.spec.ts`
  still proves shortcuts stay inert under a dialog). Reword the two "non-native MUI button" comments
  in `useNextActionsRovingFocus` / `useNextActionsDrag` to say why the guards still exist for native buttons.
- Add the Biome `noRestrictedImports` ban; widen `lint:css` to `src/**`; fix what it flags.
- `manifest.theme_color` in `vite.config.ts` → the new accent; `background_color` stays per theme
  (PWA manifest is single-valued — pick light).
- Build, inspect `dist/` for the Inter woff2 in the precache manifest; compare bundle size
  before/after (record in this file).

## Phase 3 — verification

1. Full client checklist + `client-code-reviewer` on the diff of the whole branch (in slices: DS,
   routes, components — one reviewer call per slice).
2. Full e2e suite (`cd e2e && npm run test`) against a freshly built client (watch for the stale
   `vite preview` on 4173). The 6 `.Mui*` specs (15 occurrences, listed in § Ground truth) are
   rewritten to roles / test ids / `data-selected` **inside the batch that converts their surface**
   (1, 3b, 4), so by now `grep -rn '\.Mui' e2e/*.spec.ts` must already be empty; then the long tail. Record the baseline list of pre-existing failures before starting the branch so
   regressions are separable.
3. Manual smoke, both schemes: desktop Chrome, iOS Safari PWA (drawer swipe, toast placement,
   dialog-as-sheet, fixed positioning, CodeMirror dark), one Android Chrome pass if available.
   Storybook a11y addon clean on every DS story.
4. Update `docs/` wording that says MUI (`client/CLAUDE.md` React section, root `CLAUDE.md`
   agent descriptions, `client/.claude/agents/code-reviewer.md` "React 19/MUI/IDB").

## Test matrix summary

| Area | Unit | e2e |
|---|---|---|
| colorScheme | resolve system/light/dark, storage event, `data-theme` stamp | Settings toggle flips `html[data-theme]` and a token-driven colour, persists across reload |
| useIsMobile | matchMedia mock both sides | covered by existing mobile-viewport specs |
| DS Dialog / AlertDialog | focus trap, `aria-labelledby`, Escape closes, no size-dependent variant | existing 58 `getByRole('dialog')` queries |
| Editor modes removal | `useItemEditor` resolves only page/newTab/in-flight | new spec: chip click → `/item/:id` on every list page; Settings has no "Item editor" radio; `gtd:inlineClarifyMode` in storage is ignored |
| Toast | `role`, auto-dismiss timer, action button | existing undo specs (`inbox`, `next-actions`…) |
| IconButton | throws in dev without `aria-label` | existing 233 `getByRole('button', { name })` |
| Combobox (MeetingDetails) | option filter | `edit-item-cross-account-calendar-picker` rewritten to roles |
| Drawer | open/close state | mobile nav spec (new if none exists) |
| Stylelint gate | `lint:css` in `npm run lint` | — |
| Import ban | Biome | — |
| Modal-open marker | jsdom: `isModalOpen()` true with a DS Dialog/Drawer/Menu open, false after close (pin the MUI case first, drop it in Phase 2) | `keyboard-regions.spec.ts`: `g d`, `/`, `?`, F6 and row letters inert under a dialog |
| Keyboard regions on the DS shell | `rovingRegion` / `globalShortcuts` tests unchanged (pure logic) | `keyboard-regions.spec.ts`: menu region in the permanent nav and inside the DS Drawer, accounts toolbar, filter chips, F6 cycle |
| Ranked lists + grab mode on native buttons | DS `Button` render test: Space key-up / Enter key-down click; `nextActionsKeys`, `dragReorder` tests unchanged | `ranked-lists.spec.ts`, `next-actions-keyboard.spec.ts`, `next-actions-reorder-mobile.spec.ts` (handle long-press on the DS `IconButton`) |
| Shortcut tooltips | DS `Tooltip` render test: `role="tooltip"`, text = `withShortcutHint`, delay, disabled trigger | `row-shortcut-tooltips.spec.ts` on every list + header button |
| Editor shortcuts | `editorShortcuts` / `useEditorShortcuts` tests unchanged; DS `Select` popup portals outside the editor root (render test: a key inside the popup is not `currentTarget.contains`) | `ranked-lists.spec.ts` status letters + `Cmd/Ctrl+Enter`; `item-editor-autosave.spec.ts` |

## Interview answers (2026-10-23)

| Question | Answer |
|---|---|
| Font | **Inter** (over Geist Sans / Roboto / system stack) |
| Accent | **Keep today's blue** (`#1976d2` family) |
| Icons | **lucide-react** |
| Density | **Unchanged** |
| Elevation | **Hairline borders, no shadows** |
| Drawer fallback if swipe disappoints on iOS | **Non-swipe side sheet via Dialog** |
| Public landing / legal pages | **Restyle with the DS, content identical** |
| Dialogs on phones | **No full-screen option anywhere.** The "Item editor" setting (Dialog / Expand inline / Popover / Instant / Full Page) is removed; editors are always the page. Everything else is a centred dialog on every size. |
| Weekly Review cards | **Keep inline editing** in the stage cards |
| Group B short forms | Centred `Dialog`, same on all sizes |
| Group C confirmations | `AlertDialog` |
| Group D system notices | Stay modal; "Inbox clear!" → toast |
| Group E anchored popups | Keep anchored (Menu / Popover / Select / Combobox); `DatePickerPopover` stays |

## Execution notes (2026-10-24, feat/base-ui-facelift)

- **Commits:** the user authorised one local commit per green batch on this branch; nothing is pushed.
- **Baseline:** the first full-suite baseline ran against a client bundle the vite watcher had emptied mid-rebuild, so it was discarded. It is re-run from a pristine `git archive HEAD` copy, reusing the already-running API on :4000 (same commit; later runs reuse it the same way).
- **Drawer spike (0.6): passed** in Playwright WebKit 27.2 with iPhone 13 touch emulation against the `SwipeToCloseNav` / `SwipeToCloseSheet` stories: the panel follows the finger, a full swipe closes both the nav and the sheet, a 15px or wrong-way swipe leaves them open. Base UI Drawer kept; the real iOS PWA check is the user's, in Phase 3.
- **Toast is not Base UI's Toast:** its viewport binds F6 globally while any toast is visible, which would steal the app's F6 region cycling. The DS `Toast` is a small declarative component over one persistent `role="status"` region.
- **`ButtonLink`** (not `Button render`) for links styled as buttons: Base UI's Button with `nativeButton={false}` stamps `role="button"` on the anchor.
- **`ChoiceLabel`** uses Base UI's `Field.Label` pattern (`Field.Root`, `Field.Item` per radio), which also satisfies Biome's label-control rule without a suppression.
- **Colour scheme:** the MUI-era `mui-mode` choice is adopted once into `gtd:colorScheme`; MUI's provider runs with `storageManager={null}` and a bridge in `__root.tsx` mirrors the resolved scheme into it until MUI is gone.
- **Not built as DS components:** List (plain `ul`/`li` + `ListRowShell`), Avatar (Base UI Avatar used directly in `AccountAvatar`), AppBar (a `<header>` in `_authenticated.tsx`). Combobox lands with batch 3b, Accordion only if a site needs it.
- The § Phase 0.5 note that "the stylelint px rule would flag" 1px rules is stale: the gate has no unit rule (realtime-app's has none either).
- **The local `gtd-test-mongo` container had stopped** (it runs with `--rm`, so it was gone). Every API write returned 500, which made `syncRecovery.test.ts` time out and every e2e test fail slowly — that is why the first baselines crawled. Restarted it; both pass. The full baseline was dropped in favour of rerunning any failing spec against the pristine copy.
- **Stop hook:** capped at 90s (`GTD_HOOK_BUDGET_SECONDS`), kills a timed-out block's process group (SIGINT first so Playwright stops its dev servers), and runs only the e2e specs edited this turn (user request, 2026-10-24).
- **`keyboard-regions.spec.ts:66` flake (also on main, ~1 in 5):** a second Space within one render toggles the energy chip from stale state and re-applies the filter. The spec now waits for each toggle's render. App-side follow-up, not fixed here: a fast double toggle on a filter chip should read the latest state. Separately fixed: the Next Actions list's deferred row focus no longer steals focus back after the user tabbed away while the row was mounting (`hasFocusMovedSince`).
- **Batch 3 (editor modes removed):**
  - The Weekly Review routine card opened `RoutineDialog` to edit mid-walk, which the plan missed. It now renders `RoutineEditorBody` inline in the card, the same way item cards keep inline editing.
  - "Create routine" goes to the new `/routine/new` page. A create replaces it in history with `/routine/:id` (`RoutineEditorBody`'s `onCreated`).
  - The `/routines` row's "Open routine page" button was dropped: Edit now does the same thing.
  - Process Inbox always navigates to `/process-inbox`. The dialog wizard used to batch only the items matching the inbox search, so the page now takes `?q=` (`processInboxBatch`) and returns to the searched inbox.
  - `usePageEscapeToClose` used a raw `.MuiModal-root` probe, so Escape inside an open DS popup also left the page. It now uses `isModalOpen()`.
  - e2e: `pinEditorModeToDialog` is gone from the login helpers; specs scope the editor to `itemPageWrapper` / `routinePageWrapper` / `newRoutinePage`. Two tests whose scenario no longer exists were deleted: a drag beside an expanded inline editor, and row letters inside an inline editor. `editors-are-pages.spec.ts` is new.
  - The weekly-review brief/sweep and card-fits specs fail the same way on the pristine pre-facelift copy against the same reused API on :4000. That server appears to run without `BRIEF_FAKE_MODEL=1`, so briefs never arrive; this is not a branch regression.
- **Batch 3b (pickers, clarify, item editor, next-action position, markdown):**
  - The attendee picker uses Base UI **Autocomplete** (`designSystem/Autocomplete`), not Combobox: it is free text with suggestions (MUI `freeSolo`). Picks arrive through `onItemPicked`, and Enter with nothing highlighted submits the typed text.
  - DS additions:
    - `Select` options take a `group` label (per-account calendar headers).
    - `ToggleGroup` gains `allowDeselect` (energy can be empty).
    - `IconButton` can be named by `title` alone. ClearFieldButton needs this: an `aria-label` would make every `getByLabel(<field>)` match the button too.
    - A selected `Chip` fills with its status tone (Done green, Trash red).
    - `fieldset`/`legend` are reset in `base.css`, so labelled groups (status chips, `FieldSection`) use them for semantics.
  - The meeting-details Accordion is a disclosure button over `Collapsible`. Attendee chips carry RSVP as `data-tone`, and a clickable chip with a remove button puts its click target inside the label (a button cannot hold another button).
  - Three `biome-ignore`s are new accepted cases, all on elements that were MUI `Box` before and so unchecked:
    - two key/focus delegation wrappers, which must stay React handlers so a child's `stopPropagation` is honoured;
    - the focusable scrollable notes preview (WCAG scrollable-region-focusable).
  - For Phase 2's `lint:css` widening, the app-CSS config needs:
    - `composes` allowed;
    - `:global(p)`-style descendant type selectors permitted;
    - CodeMirror's `cm-*` classes exempt from the camelCase class pattern.
  - E2E reads chip state from `aria-pressed` and `data-tone` instead of MUI classes. Status chips have `data-testid="itemEditorStatusChip"`.
- **Batches 4–10** each landed as one local commit (see `git log`). Notable fixes found along the way:
  - **Weekly Review:** decisions are recorded per entry (`completeEntry`), not on whatever card is current, which closes a fast-click race.
  - **Toast:** the DS Toast takes a `placement`, with one live region per placement. The hidden-account capture notice is centred so it never covers the sidebar's account visibility toggles; MUI centred that one notice the same way.
  - **Boot flicker on multi-account devices:** the multi-session seed adds an account just after boot. `AppResourceProvider` adopted the new snapshot urgently, which suspended to the boot boundary above the app shell. The whole shell flashed hidden and keyboard focus dropped to `<body>`, the cause of the flaky `keyboard-regions` avatar test. The provider now shows its snapshot through `useDeferredValue`. A Suspense boundary inside `<main>` was tried first and rejected: it made boot staged, and the inbox's autofocus then closed a just-opened account menu.
- **Phase 2 (MUI removed):**
  - Bundle, measured with `vite build` into a scratch directory:

    | | Main chunk | Main chunk (gzip) | All JS | Precache |
    |---|---|---|---|---|
    | Before | 1,431.68 kB | 452.67 kB | 3,200 KB | 189 entries, 3,960 KiB |
    | After | 1,347.20 kB | 423.83 kB | 3,116 KB | 189 entries, 3,878 KiB |

    The drop is small because, by then, only `__root.tsx` still pulled MUI in.
  - The Inter 400/500/600/700 woff2 files are in the service-worker precache manifest.
  - The manifest's `background_color` is now the light `--color-bg-page`. `theme_color` already equalled `--color-accent`.
  - **Import ban:** Biome `noRestrictedImports` bans `@mui/**`, `@emotion/**` and `classnames` under `client/`.
  - **`lint:css`** covers all of `src/**/*.css`. For app modules:
    - `composes` is allowed;
    - type selectors are allowed as descendants and children of a class;
    - CodeMirror's `cm-*` class names are exempt from the camelCase pattern.

    Element selectors in rendered markdown and the legal page dropped the `:global()` they never needed: CSS Modules hash only class names.
  - **Removed:**
    - `useResolvedColorScheme`, whose only consumer was the MUI bridge;
    - the MUI branch of `isModalOpen()` and its two tests;
    - the Storybook MUI wrapper.

    The `mui-mode` localStorage key is still read once, so existing users keep their colour scheme.
