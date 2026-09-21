---
name: brief-length-bound-split-across-paths
description: Brief text has THREE different length bounds by write path (authored 500 hard, model unbounded-but-MAX_TOKENS, fake 157) and the MCP tool descriptions assert the wrong one
metadata:
  type: project
---

`itemBriefs.text` has no single length bound. Enumerate by writer, not by field:

1. **Authored** (`PUT /v1/items/:id/brief`, MCP `gtd_set_brief`, `/v1/operations/batch`-adjacent) —
   `parseBriefBody` in `lib/itemBriefs.ts` enforces `BRIEF_MAX_CHARS = 500` as a **hard** 400.
2. **Model** (`writeModelBrief` ← `parseBriefResponse` ← `fitBriefText`) — **unbounded** since
   2026-09-21. `BRIEF_TARGET_MAX_CHARS = 160` is a prompt-only SOFT target; `fitBriefText` is now
   just trim-or-null. The only real ceiling is `MAX_TOKENS = 256` in `briefPrompt.ts`, and that
   bound is *not* enforced as a length — a `stop_reason: 'max_tokens'` cut lands mid-JSON, so
   `JSON.parse` throws and it surfaces as `malformed_output` rather than a truncated brief. There
   is no `stop_reason === 'max_tokens'` branch in `parseBriefOutput`.
3. **Fake seam** (`BRIEF_FAKE_MODEL=1`, e2e) — capped at 157 (`'[fake] '` + `firstSentence`'s
   `FAKE_FIRST_SENTENCE_MAX_CHARS = 150`). So **e2e can never produce a brief over 160** and never
   could exercise the old truncation branch either.

`ItemBriefSnapshotSchema` (`schemas/operations/itemBrief.ts`) is `z.string().nullable()` with **no**
length cap, so a long model brief round-trips `/sync/push` fine — the removal of truncation does not
jam a client push queue. Verified. The client render path also does not clamp (`.briefLine` has no
`-webkit-line-clamp` / `text-overflow`), so a long brief wraps rather than re-acquiring a visual
ellipsis.

**Why:** the user's explicit decision was "do not degrade, simply don't truncate, 160 is a soft
limit" — a truncating ellipsis reads as "this summary is partial, open the notes", defeating the
brief. The asymmetry (500 hard on authored, none on model) is deliberate: 500 exists to stop a
caller stashing a second notes field, not to shape a summary.

Since 2026-09-21 `parseBriefOutput` also has an explicit `stop_reason === 'max_tokens'` branch
throwing `malformed_output` ("token budget"), so a budget-cut brief is named in the log rather than
surfacing as an opaque "not JSON". It still degrades safely — nothing partial is ever stored.

**How to apply:** when a diff touches brief length, walk all three writers. Watch for **doc drift on
surfaces that promise a length the code no longer enforces** — the offender found on this review was
the MCP tool description for `gtd_generate_brief`, duplicated byte-identically in
`api-server/src/mcp/tools/items.ts` AND `mcp-server/src/tools/items.ts`, asserting the model path is
"one sentence, ≤ 160 chars". **FIXED 2026-09-21** in both copies. Keep the general lesson: the MCP
parity test compares the two copies *to each other*, so it can never catch a claim that is wrong in
both — parity passing is not evidence a description is true. Note the neighbouring "under 160 chars"
in the same `gtd_generate_brief` string is the **skip threshold**
(`BRIEF_SKIP_MIN_NOTES_CHARS`, a different 160) and is correct; don't "fix" it. Related:
[[project_mcp_tool_parity_test_names_only]], [[project_brief_declined_state_split]],
[[project_brief_prompt_cache_control_inert_on_haiku]].
