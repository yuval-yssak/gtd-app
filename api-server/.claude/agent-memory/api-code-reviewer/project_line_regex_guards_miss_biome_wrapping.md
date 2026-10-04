---
name: line-regex-guards-miss-biome-wrapping
description: Source-scanning guard tests that regex one line at a time miss Biome-wrapped multi-line calls (status arg alone on its own line); test the guard against the wrapped shape.
metadata:
  type: project
---

Guard tests that scan `src/` line by line (e.g. noGatewayStatusCodes.test.ts, 2026-10-04) tend to anchor on a preceding token (`, 502`, `status: 502`). Biome wraps long `c.json(body, status)` calls so the status sits alone on its own line (`    502,`), which the anchored regex never matches. `c.status(n)`, `new HTTPException(n…)`, `statusCode: n` and named constants slip through too.

**Why:** the guard ships green and looks proven ("fails when one is reintroduced"), but the author only tried the single-line shape.

**How to apply:** when reviewing any regex guard test, feed it the Biome-wrapped form and the alternative call shapes. Prefer a bare-literal match (`(?<![\w.])50[24](?![\w.])` on lines with comments stripped) plus an opt-out marker, over anchored context.
