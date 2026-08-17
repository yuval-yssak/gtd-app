---
name: new-page-route-has-no-inbound-link
description: New /entity/$id page routes ship deep-link-only — the sibling list row still opens the dialog, so the page has no in-app entry point and its back-target path is never exercised
metadata:
  type: feedback
---

When a new full-page entity route is added because an *external* consumer needs a resolvable URL
(MCP `url` stamping, share links, push deep links), the route consistently ships with **no in-app
navigation into it**. The sibling list page keeps opening the dialog/popover chrome from its Edit
button, so:

1. The page is reachable only by pasting a URL. Discoverability is zero and the user has two
   different editors for the same entity depending on how they arrived.
2. `useNavigateBack`'s recorded-`backTarget` branch is dead for that route — only the
   `fallbackTo` branch ever runs, so the "came from a filtered list, return to it with its
   search params" behaviour is untested and unverified for the new entity.
3. Adding the route's prefix to `DETAIL_PAGE_PREFIXES` has no observable effect yet, which makes
   it easy to forget when the in-app link is added later.

**Why:** this shape recurred with `/person/$personId` (added for MCP person URLs, 2026-08-17)
while `/people` rows kept `setEditing(person)` → `PersonEditDialog`. The same latent gap exists
wherever a page route precedes its list-row link.

**How to apply:** on any new `routes/_authenticated/<entity>.$<entity>Id.tsx`, grep for
`to: '/<entity>/'` across `src/`. If there are zero hits, ask whether the list row should navigate
instead of opening the dialog (or at least gain a CopyId/open-page affordance), and note that the
recorded-back-target path is uncovered by the new specs.

Related: [[project_multi_chrome_editor_pattern]], [[history-back-unsafe-for-deep-links]]
