---
name: reused-component-heading-order
description: Components reused on a new page bring Text variant-default headings (subtitleSm/subtitle → h6), skipping levels under the new page's h2; also public-copy vs privacy-policy drift
metadata:
  type: project
---

Settings components (e.g. ConnectClaude) use `<Text variant="subtitleSm">` for sub-headings, which renders `<h6>` by default (MUI mapping). Fine inside Settings' h6 section heading, but when reused on a new page with real `<h2>` sections (public /claude guide, 2026-11-19) the outline jumps h1 → h2 → h6.

**Why:** Text's DEFAULT_ELEMENT maps every subtitle/title variant to h3–h6 regardless of context; authors reuse the component without checking the outline, and no unit/e2e test asserts heading order.

**How to apply:** when a review reuses a component on a new route, grep it for `Text variant=` without `as=` and check the outline it lands in; ask for a heading-level prop and a test that asserts no skipped levels. Related: public copy that describes data flow to Anthropic (connector guide) can outrun `client/src/legal/privacy-policy.md` "AI processing" (which named only briefs) — check the policy when connector copy changes.
