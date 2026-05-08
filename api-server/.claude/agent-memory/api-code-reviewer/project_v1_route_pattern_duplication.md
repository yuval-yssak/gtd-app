---
name: List/cursor pagination logic duplicated across every new /v1/ router
description: parseListQuery, parseCursor, encodeCursor, buildFilter, ListQuery type, DEFAULT_LIMIT/MAX_LIMIT — copy-pasted near-verbatim across `routes/v1/items.ts`, `people.ts`, `workContexts.ts`, `routines.ts`. Ripe for extraction.
type: project
---

Every new `/v1/*` router added so far re-implements identical list-query parsing (`parseListQuery`, `parseCursor`, `encodeCursor`, `buildFilter`, the `ListQuery`/`CursorFilter` types, `DEFAULT_LIMIT`/`MAX_LIMIT` constants). As of Phase 2 step 3 there are 4 copies. Items.ts adds status+q filters; the rest are byte-identical apart from the response field name.

**Why:** the abstraction in `CLAUDE.md` calls out that any pattern repeated 2+ times must be extracted. The duplication keeps growing as steps 4-6 add more entity surfaces.

**How to apply:** when reviewing new `/v1/*` routers, flag the duplication and recommend extracting to `routes/v1/listPagination.ts` (or similar). Same for the test-setup boilerplate (`beforeAll`/`afterAll`/`beforeEach`, `login()`, `tokenWith()`) that's duplicated across each `v1<Entity>.test.ts`.
