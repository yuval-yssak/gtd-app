---
name: v1-envelope-shapes
description: v1 item/routine endpoints return varied envelopes; composite routes break tool-name→shape assumptions
metadata:
  type: project
---

The v1 API returns several distinct envelope shapes that any MCP-side response-shaping logic must handle:
- item single: bare `presentItem` object
- item list: `{ items, nextCursor? }`
- routine single: bare `presentRoutine` object
- routine list: `{ routines, nextCursor? }`
- batch: `{ ok, count }`
- routine delete: `{ ok }` or `{ ok, alreadyDeleted }`
- **routine split: `{ head, tail }`** — NOT a bare routine

**Why:** A tool-name→shape map that classifies `gtd_split_routine` as a bare `'one'` routine will silently fail to decorate it (it has no top-level `_id`), so the split successor/head never get the treatment the feature intends.

**How to apply:** When reviewing any MCP feature keyed by tool name to an expected v1 response shape, cross-check every routine/item tool against the actual route handler return, not just the common CRUD ones. Composites (`/split`, and historically `/reassign`) are the easy misses.
