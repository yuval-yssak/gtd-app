---
name: run-fence-mutation-before-trusting-it
description: A "the fence fixed the failing suite" claim usually means the fence masks a bug; mutate the fence to `false` and re-run before accepting it
metadata:
  type: feedback
---

When a change adds a time/scope **fence** (`updatedTs >= before`, `ts < cutoff`, etc.) and the
author's justification is "this fixed the other suite's failing expectations", treat that as a
**red flag, not evidence of correctness**. A fence that silences failures is often hiding an
unsound core predicate rather than encoding a real invariant.

**Why:** found on the missed-push sweep. The `before: now` fence made `calendar.test.ts`'s
relink-sweep expectations pass again — but the underlying predicate was re-pushing Google's own
edits, and the fence only suppressed that within the *current* sync run. Every subsequent run
re-triggered it. Worse: the fence was duplicated on two code paths and only ONE had a test, so
mutating the untested copy to `false` left 17/17 green.

**How to apply:** for every new guard/fence, mechanically mutate it to `if (false)` (or flip the
comparison), re-run **only the new test file**, and report the result. If the suite stays green the
guard is unpinned — demand a discriminating test naming the exact branch. Do this per *code path*,
not per *concept*: a fence copy-pasted into two collectors needs two tests. Then ask the sharper
question: "if the fence weren't here, what would this push/write do on the NEXT run?" — a fence that
only protects the current invocation is masking, not fixing.
Related: [[feedback_verify_tests_discriminate_by_stashing_source]],
[[feedback_guard_predicate_boundary_needs_branch_proof]].
