---
name: brief-prompt-cache-control-inert-on-haiku
description: The brief prompt's cache_control block is silently inert — Claude Haiku 4.5's minimum cacheable prefix is 4096 tokens and the system prompt is ~640, and the brief path records no usage so nothing surfaces it
metadata:
  type: project
---

`briefPrompt.ts` marks its single system block with `cache_control: { type: 'ephemeral' }` and both
the code comment and `docs/plans/item-brief.md` describe the prefix as cached across every call and
across the Message Batches sweep. **It is not cached.**

- `BRIEF_MODEL = 'claude-haiku-4-5'`, and Haiku 4.5's **minimum cacheable prefix is 4,096 tokens**
  (verified against the prompt-caching docs 2026-09-21; Sonnet 4.x/5 is 1,024, Opus 5 is 512 —
  Haiku has the *highest* floor of the current lineup, which is the counterintuitive part).
- The system prompt measures ~2,550 chars ≈ **640 tokens**, well under the floor. Even after the
  2026-09-21 anti-enumeration additions (~340 tokens of the total) it is ~6× too short.
- Anthropic **returns no error** for a sub-minimum `cache_control`; the request is simply processed
  uncached. The only way to detect it is `usage.cache_creation_input_tokens` /
  `cache_read_input_tokens` both being 0.

**Why it stays invisible here:** `lib/claude/agentLoop.ts` *does* accumulate
`cacheReadTokens` / `cacheCreationTokens` (and `spend.ts` prices them), but that is the
**claude-assist** path. The brief path (`briefModel.ts`, `briefBatch.ts`) reads no `usage` fields at
all — grep for `usage` under `lib/brief/` returns nothing. So there is no signal, no cost anomaly,
and no test that would ever fail.

Practical impact is small (~640 input tokens per brief on the cheapest model, and Message Batches
already halves it), so this is a **correctness-of-documentation** issue, not a spend emergency. The
danger is the reverse inference: someone sizing a future prompt addition will reason "the prefix is
cached, extra rules are nearly free" — which is exactly backwards on this model. Every token added
to `SYSTEM_PROMPT` is billed at full input rate on every single brief.

**How to apply:** when reviewing any change that grows `SYSTEM_PROMPT` (or any `cache_control` block
anywhere), check the model's minimum cacheable length against the actual block size before accepting
a "it's cached, so it's free" justification. Either fix the comment to say the block is below
Haiku's cache floor and therefore uncached, or (if caching is genuinely wanted) note that the prompt
would have to grow past 4,096 tokens for the flag to do anything. Related:
[[project_brief_length_bound_split_across_paths]],
[[feedback_prompt_text_tests_are_not_behaviour_tests]].
