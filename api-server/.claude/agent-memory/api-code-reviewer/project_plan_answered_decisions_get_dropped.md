---
name: plan-answered-decisions-get-dropped
description: Implementations of docs/plans/*.md have shipped contradicting the user's inline answers to "Open decisions" — always diff the answered decisions against the code before approving
metadata:
  type: project
---

When a `docs/plans/<feature>.md` has an "Open decisions (please answer inline)" section, the user
answers by typing a bare word under each numbered question. Those answers have been dropped during
implementation: the item-brief Phase 2 review (2026-09-20) shipped `BRIEF_MODEL = 'claude-opus-5'`
with a test asserting that exact string and PUBLIC_API.md documenting it, while the plan's open
decision 1 was answered **"Haiku"** (`claude-haiku-4-5`, 5x cheaper). The proposal text in the
decisions table kept the *proposed* default, which is what the implementer followed.

**Why:** the answers are terse one-word lines with no heading, easy to skim past; the surrounding
table still advertises the pre-decision default, so the code "matches the plan" if you only read
the table.

**How to apply:** on any review whose prompt cites a plan document, open the plan's decisions
section FIRST and build a checklist of answered decisions, then grep the diff for each one before
writing the verdict. Treat a contradiction as a Critical/Changes-requested item, not a nitpick —
these decisions are cost, UX-default and security choices the user made explicitly.

Related: [[feedback-verify-compile-before-trusting-pass-claims]] — same family of "the prompt's
self-report is not evidence".
