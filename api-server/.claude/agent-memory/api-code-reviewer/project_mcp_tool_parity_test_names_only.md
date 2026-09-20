---
name: mcp-tool-parity-test-names-only
description: HISTORICAL — mcpToolParity.test.ts used to compare tool NAME sets only; as of 2026-09-16 it also compares descriptions + serialized input JSON Schemas, so copy drift is now genuinely guarded
metadata:
  type: project
---

**RESOLVED 2026-09-16.** `mcpToolParity.test.ts` now captures each `registerTool` call's `description` plus `z.toJSONSchema(z.object(inputSchema), {io:'input'})` and deep-equals the two copies. I verified it is not vacuous by mutating one `.describe()` string in the api-server copy — the test failed as expected. Copy drift in schemas, field descriptions, and tool descriptions is now caught. Handler *bodies* are still unguarded (handlers are never invoked during registration), so a behavioural divergence between the two copies' handlers would still ship silently — keep diffing the files directly when a handler changes.

The original problem, kept for context:

`api-server/src/tests/mcpToolParity.test.ts` is the only automated guard on the "keep the two MCP tool copies identical" rule, and it asserts nothing but the sorted set of registered tool *names* (plus a length floor). Input schemas, field-level `.describe()` text, tool descriptions, and handler bodies can diverge silently between `mcp-server/src/tools/*.ts` (source of truth) and `api-server/src/mcp/tools/*.ts` (copy).

**Why:** the stub server used by the parity test captures only `registerTool(name, ...)`'s first argument, so everything downstream of the name is discarded.

**How to apply:** on any diff touching an MCP tool, do NOT treat a green parity test as evidence the copies match. Diff the two files directly (`diff <(tail -n +2 api-server/src/mcp/tools/X.ts) mcp-server/src/tools/X.ts` — the api-server copy carries one extra `// COPIED from ...` header line). Also note there are no mcp-server tests that exercise the input schemas' parse behaviour beyond a couple of one-off `safeParse` spot checks in `mcp-server/src/tests/tools.test.ts`, so schema regressions (e.g. an option becoming required, a `.describe()` getting buried inside an `anyOf` branch by `.nullable()`) ship unnoticed.
