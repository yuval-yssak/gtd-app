---
name: lane-a-emergent-review-findings
description: Lane A /v1/claude/assist final holistic review — feature complete & approved. Findings 1 (allDay matrix gap) + 2 (dead calendarSideEffect kind) + signing-key guard CLOSED 2026-06-06; findings 3 & 4 still load-bearing invariants
metadata:
  type: project
---

Final whole-feature review of Lane A "Clarify with Claude" (issue #21, all phases assembled). No critical/data-loss issues; verdict was Approved-with-suggestions. The prior per-step gaps are CLOSED: throw-path metering test exists (`v1ClaudeAssist.test.ts` "meters partial usage when the model call throws"), and `resolveCalendarContext` now has a real try/catch + a corrupt-integration degrade test. See [[spend-cap-local-day-and-throw-path-gaps]], [[resolve-calendar-context-no-degrade]].

**Emergent findings worth re-checking on any future Lane A change:**

1. **CLOSED 2026-06-06 — `allDay` is now matrix-gated.** `allDay` was added to `STATUS_SPECIFIC_FIELDS` + the `calendar` row of `STATUS_FIELD_MATRIX` (schemas/operations/item.ts). It now rejects on active non-calendar statuses and is preserved through done/trash (ALL_STATUS_SPECIFIC) for audit. Round-trip verified safe: all client status-transition mutators (`clarifyToInbox/NextAction/WaitingFor/SomedayMaybe` in client itemMutations.ts) strip `allDay`, and every server inbound-GCal write that sets `allDay` forces `status:'calendar'`. **Residual nit:** proposalSchema.ts:26 comment still calls `allDay` "a universal field … carries no write risk alone" — now FALSE; the agent has no `allDay` guidance in the system prompt so it could still propose `allDay` on a non-calendar status → apply 400s `invalid_operation`. **How to apply:** when reviewing any new proposable field, check whether it's matrix-gated; universal fields slip through silently.

2. **CLOSED 2026-06-06 — dead `calendarSideEffect` kind removed.** `ExecuteTokenKind` collapsed to the single member `'itemPatch'` (kept as a named alias for future re-extension) and the unreachable `kind !== 'itemPatch'` 400 branch was deleted from the apply handler. Schema enum + `ProposedSideEffect.kind` were already single-member. No dangling refs remain.

3. **Mint/redeem allowlists CANNOT drift** — both the token's `fields` (withExecuteTokens filter) and apply's `PROPOSABLE_FIELD_SET` derive from the single `PROPOSABLE_ITEM_FIELDS` constant, so a normal proposal is always appliable. Good invariant; preserve it (don't introduce a second allowlist).

4. **Ownership is consistent at every seam** — assist 404s if item.user != caller, so ownerUserId == caller by construction; token minted with user=ownerUserId; apply re-checks payload.user==caller AND re-loads via findByOwnerAndId(itemId, payload.user). No caller-session leak. The apply 403 is `forbidden` (cross-account token replay), distinct from the scope gate `forbidden_scope`; both correctly documented.

**Signing-key guard — partially hardened 2026-06-06:** `getSigningKey` now measures `Buffer.byteLength(key,'utf8') >= 32` (bytes, not code points) and emits a one-time `console.warn` when the public in-repo dev fallback is used outside production. Production still hard-errors. NOTE the still-open gap from [[signing-key-dev-fallback-weak-guard]]: this hardens EXECUTE_TOKEN_SIGNING_KEY only — the token *encryption* key getters retain the silent dev fallback with no prod boot check.
