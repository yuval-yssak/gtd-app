---
name: mcp-parity-test-names-only
description: mcpToolParity.test.ts only compares registered tool NAME sets — descriptions, input schemas, webUrl maps and SERVER_INSTRUCTIONS can drift silently between the two MCP copies
metadata:
  type: project
---

`api-server/src/tests/mcpToolParity.test.ts` asserts only that the two MCP copies register the
**same set of tool names**. It does NOT compare tool descriptions, Zod input schemas,
`webUrl.ts`'s `SHAPE_BY_TOOL`/`PATH_BY_ENTITY` maps, or `SERVER_INSTRUCTIONS`. Copies can and
have drifted on all of those while the parity test stays green.

Confirmed drifts observed (both pre-existing as of 2026-08-17, neither caught by any test):
- `people.ts`: mcp-server uses the shared `notesSchema` (carries the Markdown-links `.describe()`
  guidance); the api-server copy inlines `z.string().optional()` and has no `notesSchema` in its
  `tools/types.ts` at all — so remote `/mcp` clients never see the Markdown-links hint on `notes`.
- `SERVER_INSTRUCTIONS`: the three-line "every `notes` field is rendered as Markdown / write
  Markdown links" paragraph exists only in `mcp-server/src/index.ts`, not in
  `api-server/src/mcp/registerTools.ts`.

**Why:** the two copies are kept in lockstep by convention plus a name-set test; the test's name
suggests stronger coverage than it delivers, so reviewers/authors assume drift is impossible.

**How to apply:** when reviewing any change to the MCP tool surface, diff both copies **textually**
(`diff <(tail -n +2 api-server/src/mcp/tools/X.ts) mcp-server/src/tools/X.ts`) rather than trusting
the parity test. Also diff `SERVER_INSTRUCTIONS` between the two files by hand. Flag any drift in
behaviour-bearing text (descriptions, `.describe()` guidance, instructions) — these are the actual
prompt surface the model sees, so drift means the stdio and remote servers behave differently.
Related: [[mcp-webUrl-shape-map]] if that memory is ever written.
