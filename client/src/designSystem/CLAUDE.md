# Design system (`client/src/designSystem/`)

The client's only component library: **Base UI (`@base-ui/react`) + typed CSS Modules + one token
file**. It replaced MUI + Emotion (plan: [`docs/plans/base-ui-facelift.md`](../../../docs/plans/base-ui-facelift.md)).
The structure is ported from `~/winn-ai/realtime-app/src/designSystem/`; the value is the discipline
(layers, semantic tokens, data-attribute variants, a stylelint gate), not Base UI itself.

Import from the barrel: `import { Button, Dialog, Text } from '../designSystem'`. Icons come from
`lucide-react` (named imports, tree-shaken).

## Tokens & cascade

- **Layer order is declared once, in `tokens/base.css`:**
  `@layer gtd.tokens, gtd.base, gtd.components, gtd.composites, gtd.overrides;`
  - `gtd.tokens` — custom properties (`tokens/variables.css`).
  - `gtd.base` — the document reset (`tokens/base.css`), the `.srOnly` utility, the pre-React
    `.dbUpgradeBlockedNotice`, and `body.nextActionsDragging` (set by `useNextActionsDrag` for a
    pointer drag: no text selection, no scroll chaining). Element selectors are allowed only there.
  - `gtd.components` — basic components: Text, Button, IconButton, Chip, TextField, Select, Switch,
    Checkbox, RadioGroup, ChoiceLabel, Tooltip, Separator, Tabs, ToggleGroup, Spinner, ProgressBar,
    Skeleton, Badge, Callout, Collapsible, Autocomplete.
  - `gtd.composites` — composites that restyle a nested basic: Dialog, Drawer, Menu, Popover,
    Toast, Card, ButtonGroup, StepIndicator. The extra layer means a composite always wins over the
    basic's own rules with no specificity games.
  - `gtd.overrides` — reserved, empty.

  App CSS Modules are **unlayered**, so a consumer's `className` beats every layer: no
  `!important`, no `.cls.cls` outspecifying.
- Every colour, radius, space step, type size and line height, shadow, motion duration/easing and
  z-index is a token in `tokens/variables.css`. Light values on `:root`, dark on `:root[data-theme="dark"]`; alpha colours
  are 8-digit hex (no `color-mix()` — the iOS PWA is WebKit).
- **Spacing is a 4px scale; MUI's unit was 8px.** An old `sx={{ p: 2 }}` is `var(--space-4)`.
  Keeping that mapping exact is what keeps the facelift density-neutral.
- `data-theme` is stamped only by `lib/colorScheme.ts` (`startColorSchemeSync()` in `main.tsx`);
  `color-scheme` is bound to it in the reset so native controls and scrollbars follow.
- The md breakpoint (900px) is `hooks/useIsMobile.ts` in JS and a literal `@media (width >= 900px)`
  in CSS — media queries cannot read custom properties.

## Authoring rules (stylelint + review)

- Variants and booleans are **data attributes** (`data-variant="ghost"`, `data-selected={flag || undefined}`),
  matching Base UI's own `data-open` / `data-disabled`. Never class-name maps, never `sx` / `style`
  for appearance. A per-call number (a spinner diameter, textarea rows) goes in as a custom property.
- `stylelint.config.js` (`npm run lint:css`, part of `npm run lint`) bans raw colours, physical
  properties (logical only), `!important`, literal z-indexes, literal `font-size` (DS and app
  modules alike; the reset's root `100%` is the one documented exception), and element selectors in
  DS modules.
- **Two prop shapes.** *Primitives* — Button, ButtonLink, IconButton, Chip, Card, Callout, Text,
  Skeleton, Spinner, ButtonGroup, and the Dialog and Menu parts (`DialogTitle`/`DialogContent`/…,
  `MenuItem`/`MenuPopup`/…) — extend `ComponentProps<'…'>` (or the Base UI part's props), so any
  DOM attribute passes through. *Controlled widgets* — Select, RadioGroup, ToggleGroup, Tabs,
  TextField, Switch, Checkbox, Autocomplete, Toast, Tooltip, Dialog/AlertDialog, Drawer, Popover,
  Collapsible, Badge, ProgressBar, StepIndicator, Separator — expose a **closed** prop set: their
  value / change callback / options, plus `aria-label`, `className` and `data-testid` (and the few
  documented extras such as TextField's `inputProps` or Switch's `controlProps`). A closed set is
  what keeps call sites off Base UI's internals; widen it deliberately, never by spreading
  `ComponentProps`. Either way `className` is merged last via `clsx`. **Every optional prop is
  typed `?: T | undefined`** — the client compiles with `exactOptionalPropertyTypes`, and call
  sites forward maybe-undefined values all the time.
- **Tone names: action vs status.** Things you *do* — Button, IconButton, MenuItem — take
  `tone="danger"` (a destructive action). Things that *report* — Chip, Callout, Badge, Text, Toast —
  take `tone="error"` (a failed state). The split is deliberate: "danger" warns before the act,
  "error" describes what already happened. Both resolve to `--color-status-error`.
- React 19: `ref` flows through props, no `forwardRef`.
- Each exported component has its own `*.stories.tsx` (one story per state) and a jsdom render
  test beside it (`// @vitest-environment jsdom` on the first line; the rest of the suite stays in
  `node`). The internal `ChoiceLabel` has a test; its states are shown through the Switch,
  Checkbox and RadioGroup stories.

## Contracts the app depends on

- **Modal marker.** Every popup that must silence page shortcuts (Dialog, AlertDialog, Drawer, Menu,
  Popover, Select popup, Autocomplete suggestions — so page shortcuts go quiet while they are
  open) stamps `MODAL_POPUP_ATTR` (`data-modal-popup`) on its Popup;
  `lib/keyboardRegionDom.ts` `isModalOpen()` looks for `[data-modal-popup][data-open]`. Tooltips and
  toasts never stamp it. Never `keepMounted` a closed modal popup — presence must mean open.
- **Tooltip = MUI parity.** A string `title` becomes the trigger's `aria-label` unless it has one;
  opens after 100ms on hover or focus; the popup is `role="tooltip"` showing exactly the title
  (`withShortcutHint` text, e.g. `Edit (e)`). Tooltips never open on touch. A disabled button needs
  a `<span>` wrapper. `IconButton` adds a native `title` fallback except inside a Tooltip.
- **IconButton** requires `aria-label` — or `title` alone where an aria-label would collide with a field label (ClearFieldButton; never wrap such a button in a Tooltip, which copies its title into `aria-label`) — and passes every other prop (`data-row-action`,
  `aria-keyshortcuts`, `tabIndex`) to the `<button>`.
- **Buttons are native.** Space clicks on key-up, Enter on key-down — the Next Actions grab-mode
  guards rely on suppressing exactly those. Navigation that should look like a button is a
  `ButtonLink` (`render={<Link to=… />}`), which stays `role="link"`: Base UI's Button with
  `nativeButton={false}` would stamp `role="button"` on the anchor.
- **Toast is not Base UI's.** Base UI's toast viewport binds F6 globally while a toast is visible,
  which would steal the app's F6 region cycling. `Toast` is a small declarative component that
  renders into one persistent `role="status"` region per `placement` — `start` (default; bottom-start
  on wide screens) and `center` (for a notice about the sidebar's own controls, which a start toast
  would cover). `main.tsx` creates both before any toast, so a toast arrives in an existing live
  region and is announced; errors add `role="alert"`. The body mounts only while
  open, so its pause-on-hover/focus latch can never outlive a showing. Unlike MUI's Snackbar,
  Escape does not dismiss a toast (Escape belongs to whatever popup or region has focus). The
  region sits outside every DS Dialog, so pressing a toast's action while a Dialog is open counts
  as an outside press and closes the Dialog — decide that interaction before a Dialog hosts a
  toast trigger.
- **Text** keeps MUI's default element per variant (`title` → `h5`, `subtitleSm` → `h6`, `body` → `p`…)
  so the page outline and every `getByRole('heading')` survive. `as` overrides it. Each page's own
  title passes `as="h1"` (ListPageHeader and DetailPageHeader do it for you), so every page has
  exactly one h1 (`page-titles.spec.ts` pins this).
- **Chip**: a clickable chip *is* the `<button>`; a toggle chip exposes `aria-pressed` and
  `data-selected`. Selected, it fills accent — or its status tone (`success`/`warning`/`error`/`info`).
  It cannot be both clickable and removable (a button cannot hold a button): put the click target
  inside a static chip's `label` and keep `onDelete` (MeetingDetails' attendee chips).
- **Select** options may carry a `group` label; consecutive options sharing one render under it.
- **ToggleGroup** is exclusive (one segment always pressed) unless `allowDeselect`, where pressing
  the active segment reports `''`.
- **Autocomplete** is free text with suggestions (MUI `freeSolo`): the caller filters `items`,
  `onItemPicked` fires on a pointer pick or Enter on the highlighted suggestion, and `onSubmitText`
  on Enter with nothing highlighted. No suggestions, no popup.
- **Dialog** is a centred card on every size (no full-screen variant, by decision). `AlertDialog`
  is `role="alertdialog"`, never closes on a backdrop press, and opens with focus on the dialog
  itself rather than its first (often destructive) button. `onClose` reports `escapeKey` /
  `backdropClick`; the dialog's own buttons close it by setting `open` to false.
- **Destructive confirmations** (delete, discard, revoke, remove) put a `variant="solid" tone="danger"`
  confirm beside a default (ghost) Cancel, in an `AlertDialog` — unless the dialog's first
  interaction is a field or a choice (delete account's typed email, disconnect calendar's
  keep-or-remove radio), which makes it a `Dialog` with focus on that control. A destructive
  option *among* several (SyncRecoveryDialog's discard paths, Disconnect) stays a ghost
  `tone="danger"` button.
- **CSS custom properties in `style`** are typed by `src/types/cssCustomProperties.d.ts`, so
  `style={{ '--account-color': color }}` needs no cast.
- **Reduced motion.** Every entry/exit transition and decorative animation (Dialog, Drawer, Popover,
  Menu, Select, Tooltip, Toast, Collapsible, the Tabs indicator, Skeleton) is switched off — or,
  for a progress indicator, slowed — under `@media (prefers-reduced-motion: reduce)`. A new
  animated component adds the same block.
- **TextField** puts the label above the control and links it, so `getByRole('textbox', { name })`
  and `getByLabel` work; `data-testid` lands on the field root (as MUI's did), `inputProps` on the
  control.
