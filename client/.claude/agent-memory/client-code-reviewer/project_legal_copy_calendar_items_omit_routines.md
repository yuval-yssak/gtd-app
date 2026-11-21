---
name: legal-copy-calendar-items-omit-routines
description: New Anthropic-bound features (Ask Claude) ship with no privacy edit; Privacy/Limited Use copy says Google data reaches X via "calendar items" but imported GCal recurring series become routines carrying event title + description (template.notes); also "used only for A and B" lists get a new use bolted on as a trailing sentence.
metadata:
  type: project
---

Legal copy about where Google Calendar data flows keeps naming only "calendar items". Calendar routines imported from a Google recurring series also carry the event title and description (`template.notes`, api-server `routes/calendar.ts` import path), and the public projections/MCP expose them. Item briefs are items-only, so that sentence is fine; any surface exposing routines (public API, MCP connector) is not.

Second recurring shape: a Limited Use "Calendar data is used only to provide: A, B" sentence gets a new use appended as a separate sentence after it, which contradicts the "only". Demand the new use be folded into the enumerated list, in all mirrors (privacy-policy.md, landingContent GOOGLE_LIMITED_USE_STATEMENT, index.html noscript) — and the noscript mirror has no test asserting the new sentence.

Third shape: a NEW feature that sends item content to Anthropic (Ask Claude, feat/ask-claude 2026-11-21 — title/status/notes into the user's Claude routine) ships with zero edits to client/src/legal/privacy-policy.md, whose AI section says "for one feature: Item briefs" and whose Limited Use list is exhaustive. Grep the diff for client/src/legal + lib/landingContent.ts whenever server code builds a payload for Anthropic.

**Why:** seen on feat/mcp-directory-readiness (2026-11-19) Claude-connector disclosure.
**How to apply:** on any privacy/landing edit about Google data, list every entity that can hold imported GCal content and check "only" enumerations.
