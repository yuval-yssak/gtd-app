---
name: base-ui-render-link-role-button
description: Base UI Button with render={<Link/>} + nativeButton:false always stamps role="button" on the <a>; MUI's component={Link} kept it a link. Breaks getByRole('link') and AT semantics.
metadata:
  type: project
---

`@base-ui/react` 1.7 `internals/use-button/useButton.js` merges `{ role: 'button' }` whenever `nativeButton` is
false, anchors included. The render element's own props win in the merge (`mergeProps(props, render.props)`), so a
Link without an explicit role becomes `<a role="button">`, and Space on it dispatches a click on key-up.

**Why:** the DS `Button`/`IconButton` advertise `render` for router links, and the landing page's `landingSignIn`
(Google-OAuth-reviewed page) is `component={Link}` today. The e2e suite has ~26 `getByRole('link')` queries.

**How to apply:** when a batch converts a link-styled button, check the rendered role. Either a separate
link-styled component that does not go through useButton, or an explicit `role={undefined}` override with a
test. Also: Base UI Select/RadioGroup/ToggleGroup roots are generic, so `next as V` casts in DS wrappers can be
dropped (verified to compile 2026-10-24).
