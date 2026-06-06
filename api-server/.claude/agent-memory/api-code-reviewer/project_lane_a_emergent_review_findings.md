---
name: lane-a-emergent-review-findings
description: Lane A /v1/claude/assist final holistic review — feature complete & approved-with-suggestions; allDay bypasses status×field matrix, calendarSideEffect kind is dead end-to-end
metadata:
  type: project
---

Final whole-feature review of Lane A "Clarify with Claude" (issue #21, all phases assembled). No critical/data-loss issues; verdict was Approved-with-suggestions. The prior per-step gaps are CLOSED: throw-path metering test exists (`v1ClaudeAssist.test.ts` "meters partial usage when the model call throws"), and `resolveCalendarContext` now has a real try/catch + a corrupt-integration degrade test. See [[spend-cap-local-day-and-throw-path-gaps]], [[resolve-calendar-context-no-degrade]].

**Emergent findings worth re-checking on any future Lane A change:**

1. **`allDay` bypasses the status×field matrix.** `allDay` is in `PROPOSABLE_ITEM_FIELDS` (proposalSchema.ts) but is a *universal* field — NOT in `STATUS_SPECIFIC_FIELDS` (schemas/operations/item.ts). So the matrix never rejects `allDay` on a non-calendar status; a `{allDay:true}` patch on a `nextAction` item persists a meaningless flag. Low severity (no GCal pushback without status:calendar + calendarIntegrationId). By contrast `timeStart`/`timeEnd` ARE status-specific → correctly 400 `invalid_operation` on a non-calendar status. **How to apply:** when reviewing any new proposable field, check whether it's matrix-gated; universal fields slip through silently.

2. **`calendarSideEffect` kind is dead end-to-end.** Referenced in `ProposedSideEffect.kind`, `ExecuteTokenKind`, and the json_schema enum, but nothing mints it (`withExecuteTokens` only emits `itemPatch`) and `applyItemPatch` rejects non-`itemPatch` (400 invalid_request). The calendar use-case is achieved via an itemPatch with `status:calendar` + `timeStart/timeEnd`. It's reserved scaffolding, not harmful. Don't assume it round-trips.

3. **Mint/redeem allowlists CANNOT drift** — both the token's `fields` (withExecuteTokens filter) and apply's `PROPOSABLE_FIELD_SET` derive from the single `PROPOSABLE_ITEM_FIELDS` constant, so a normal proposal is always appliable. Good invariant; preserve it (don't introduce a second allowlist).

4. **Ownership is consistent at every seam** — assist 404s if item.user != caller, so ownerUserId == caller by construction; token minted with user=ownerUserId; apply re-checks payload.user==caller AND re-loads via findByOwnerAndId(itemId, payload.user). No caller-session leak. The apply 403 is `forbidden` (cross-account token replay), distinct from the scope gate `forbidden_scope`; both correctly documented.

**Minor doc nits (non-blocking):** stale `// absent in step (b)` comment on `ProposedSideEffect.executeToken`; apply's `kind !== 'itemPatch'` → 400 invalid_request branch is unreachable today and not in the PUBLIC_API.md apply error table. Pre-existing (out of scope): executeToken `getSigningKey` still uses loose `>=32` utf8 guard with silent in-repo dev fallback — see [[signing-key-dev-fallback-weak-guard]].
