---
name: brief-prompt-cache-control-inert-on-haiku
description: Brief prompt cache_control was inert on Haiku 4.5 (4096 floor); live since the 2026-10-18 move to Haiku 5.5 (512 floor). Floors are per-model and non-monotonic; the brief path records no usage, so nothing surfaces a regression
metadata:
  type: project
---

History: on `claude-haiku-4-5` the single system block (~640 tokens) was below Haiku 4.5's 4,096-token
minimum cacheable prefix, so `cache_control` was silently ignored (Anthropic returns no error, only
`cache_creation_input_tokens: 0`). On 2026-10-18 `BRIEF_MODEL` moved to `claude-haiku-5-5`, whose
floor is 512, so the marker became live.

**Why it stays relevant:** the brief path (`briefModel.ts`, `briefBatch.ts`) still reads no `usage`
fields, so a future model switch back to a high-floor model, or the prompt shrinking under 512, would
silently make caching inert again with no signal anywhere. Floors are NOT monotonic across
generations (Haiku 4.5 4096, Sonnet 4.x/5 1024, Opus 5 / Haiku 5.5 512).

**How to apply:** on any `BRIEF_MODEL` change or `SYSTEM_PROMPT` shrink, check the new model's floor
against the block size and that the `buildSystemBlocks` comment + docs/plans/item-brief.md (both the
decisions table AND § 3.3 Cost, which drifted once) say the same thing. Reject "it's cached, so extra
rules are free" — on-demand briefs are isolated calls outside the 5-min TTL and pay full rate plus the
1.25x write. Related: [[project_brief_length_bound_split_across_paths]],
[[feedback_prompt_text_tests_are_not_behaviour_tests]].
