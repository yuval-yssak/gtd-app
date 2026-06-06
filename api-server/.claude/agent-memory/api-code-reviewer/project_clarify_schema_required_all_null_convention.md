---
name: clarify-schema-required-all-null-convention
description: CLARIFY_PROPOSAL_SCHEMA must list every property in `required` (Anthropic strict structured-output has no optional props); optionality = nullable anyOf + compactPatch null-strip. Keep SYSTEM_PROMPT in sync.
metadata:
  type: project
---

`CLARIFY_PROPOSAL_SCHEMA` (proposalSchema.ts) feeds Anthropic `output_config.format` strict json_schema, which has NO optional-property concept — every key under `properties` MUST appear in `required` or the API rejects with `400 invalid_request_error: "Schema is too complex."` (the route maps non-credit 400 → 502 agent_error, so this surfaces as 502s). Optionality is expressed as `nullable(schema) = anyOf:[schema,{type:'null'}]` + `compactPatch()`/`extractProposal()` (agentLoop.ts) stripping nulls to restore the "patch holds only changed fields" invariant. The `type:['string','null']` shorthand is REJECTED on nodes that also carry an `enum` — must use `anyOf`.

**Why:** Live-reproduced root cause of /v1/claude/assist 502s (Jun 2026). Fix verified against the real API.

**How to apply:** On any edit to this schema (or any new Anthropic structured-output schema in this codebase): (1) every property recursively required — clarifyProposalSchema.test.ts `everyPropertyRequired` guards this; (2) enum nodes stay `anyOf`-wrapped (NOT asserted by the test yet — a shorthand refactor would pass CI and re-break prod); (3) the SYSTEM_PROMPT and schema are COUPLED and drift silently — the prompt still says "only include fields you are changing" while the schema forces every field present + null-for-unchanged. Flag prompt/schema contradiction on review. (4) null≡unchanged means field-CLEARING is not expressible via the proposal — not a regression (pre-fix omission behaved the same) but easy to mistake for one.
