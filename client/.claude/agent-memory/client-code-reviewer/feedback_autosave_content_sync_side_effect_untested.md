---
name: autosave-content-sync-side-effect-untested
description: New propagation side effects wired into autosave commit paths (persistRoutineText) ship tested only at the pure-helper level, never at the commit-path level.
metadata:
  type: feedback
---

When a new open-item / child-entity propagation side effect is threaded into an autosave `commit` callback (e.g. `persistRoutineText` calling `syncOpenItemAfterNextActionEdit` for nextAction routines), the orchestrator itself gets thorough unit tests but the *autosave wiring* (that the commit actually invokes the propagation with `previous: live` pre-write state, and that a debounced burst chains baselines correctly) is left unasserted.

**Why:** Same class as [[feedback_new_side_effect_skips_existing_mutation_test]] and [[feedback_passthrough_helper_untests_wiring]] — the load-bearing part (the call site passing the right `previous`) is exactly what's untested; the pure helper passing in isolation proves nothing about the burst-chaining claim in the code comment.

**How to apply:** When reviewing autosave `commit` callbacks that gained a propagation call, require a test that drives the controller (or the extracted `persistRoutineText`-equivalent) across two commits and asserts the second commit's `previous` is the first commit's persisted state — not the mount-time entity.
