---
name: prompt-text-tests-are-not-behaviour-tests
description: A test asserting the system prompt contains a rule proves the string shipped, never that the model obeys it — say so explicitly rather than counting it as regression coverage for a model-behaviour defect
metadata:
  type: feedback
---

When a defect is "the model produced bad output" and the fix is a prompt rule, the accompanying
`expect(systemText(...)).toContain('<rule>')` test is a **shipping check**, not a regression test.
It discriminates (it fails on the unmodified prompt, so it is not vacuous), but what it pins is
"the sentence is in the prompt" — it cannot fail when the model ignores the rule, which is the
actual failure mode the user reported.

**Why:** on the 2026-09-21 brief soft-limit review, two defects were fixed together: a deterministic
one (`fitBriefText` truncated and appended `…`) and a probabilistic one (the model enumerated a
numbered list). The unit tests for the first are genuine regression tests. The tests for the second
can only ever assert prompt text. The author had already done the right thing — 6 real Haiku runs
against the user's actual item content, 3 before and 3 after adding the BAD/GOOD example pair, with
before/after char counts — but that evidence lives only in the PR description, not in CI.

**How to apply:**
- Accept the prompt-text test; it guards against someone silently deleting the rule in a reword.
- State plainly in the review which of the two defects has executable coverage and which does not,
  so the count is not inflated.
- Do **not** demand a model-behaviour test in CI — it would be non-deterministic and cost money on
  every run. Ask instead that the manual eval evidence (prompt version, N runs, char counts,
  verbatim outputs) be recorded next to the prompt or in the plan doc, so the next person rewording
  `SYSTEM_PROMPT` knows an eval was run and what it showed.
- For e2e: `BRIEF_FAKE_MODEL=1` builds its own string and never calls the model, so an e2e test
  cannot cover model output quality either. Check whether the fake path can even reach the changed
  branch before asking for e2e (see [[project_brief_length_bound_split_across_paths]] — the fake
  caps at 157 chars, so it could never reach the old truncation branch).
