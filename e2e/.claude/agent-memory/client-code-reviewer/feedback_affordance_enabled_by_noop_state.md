---
name: affordance-enabled-by-noop-state
description: A new undo/reverse stack records an entry even when the underlying transform was a documented no-op, so the button lights up and does nothing on click.
metadata:
  type: feedback
---

When a feature adds an in-memory stack that drives a button's enabled state (defer/un-defer, undo history, breadcrumb), check whether the recording step can fire in a case where the paired transform is a **documented no-op**. If so the affordance enables and the click does nothing.

**Why:** Caught in the weekly-review defer stack. `skip()` pushed the head id unconditionally, but `skipCurrentItem` on a one-item queue is a deliberate no-op (cycle-to-back has nowhere to go). The ▶ button was guarded by `pending.length <= 1`, but **Escape routed to the same handler with no guard** — so pressing Escape on a single-item stage enabled ◀ with an inviting tooltip, and clicking it hit `unskipToHead`'s `indexOf(id) <= 0` same-reference early return. Worse, it masked the genuine revisit affordance behind a dead first click.

**How to apply:** Two questions on any diff adding such a stack:
1. Does the recorder run on *every* path into the action, or only the button? Keyboard handlers, editor `onClose` callbacks, and portal-less fallback bars commonly share one handler while only the button carries the disabled guard.
2. Do the pure helpers already document a same-reference no-op case? Those returns are exactly the inputs the recorder must refuse to record.

The fix belongs in the recorder (guard before the state write), not in the button's disabled prop — the button is only one of several entry points. Ask for a test asserting the control stays **disabled** after the no-op path; a test asserting the queue is unchanged will pass either way.

Related: [[feedback_inflight_escape_hatch_semantics_mismatch]], [[feedback_conditional_render_gate_loses_coverage]], [[feedback_dismiss_button_tests_pass_by_timeout]]
