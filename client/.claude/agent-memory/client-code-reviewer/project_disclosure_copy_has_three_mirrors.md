---
name: disclosure-copy-has-three-mirrors
description: Data-use / AI disclosure copy lives in privacy-policy.md, landingContent.ts AND index.html <noscript>; edits routinely miss the noscript mirror and LEGAL_EFFECTIVE_DATE
metadata:
  type: project
---

When a feature that processes user data is added or removed, the disclosure text has to change in three places: `client/src/legal/*.md`, `client/src/lib/landingContent.ts`, and the `<noscript>` homepage block in `client/index.html` (Google OAuth verification reads the plain-fetch version). `landingContent.test.tsx` only asserts the noscript block *contains* certain phrases, so stale extra phrases pass green.

**Why:** 2026-10-22 Clarify-with-Claude removal updated the policy + landingContent but left "clarify-with-AI assistant" in index.html noscript, left "per-day counts of AI usage" (the deleted claudeUsage collection) in the policy, and did not bump `LEGAL_EFFECTIVE_DATE` although the policy promises to on any change.

**How to apply:** on any legal/landing copy diff, grep `client/index.html` for the removed/added phrase, check the "What we collect" section for data the change stops/starts storing, and check `LEGAL_EFFECTIVE_DATE` in `lib/legalDocuments.ts`.
