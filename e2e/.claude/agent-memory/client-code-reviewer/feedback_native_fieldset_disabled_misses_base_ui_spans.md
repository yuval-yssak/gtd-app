---
name: feedback_native_fieldset_disabled_misses_base_ui_spans
description: MUI→Base UI ports that lock a form with native `<fieldset disabled>` leave DS RadioGroup/Checkbox/Switch live — Base UI renders them as spans
metadata:
  type: feedback
---

A native `<fieldset disabled>` used to lock a whole MUI form section (MUI radios/switches were real `<input>`s). After the port, Base UI `Radio.Root`, `Checkbox.Root` and `Switch.Root` render `<span>`s and read `disabled` only from their own props or a Base UI `Fieldset`/`Field` context — never from a native fieldset. So the section looks dimmed while those controls still click, keyboard-toggle and fire `onValueChange`. `Toggle` (ToggleGroup), Chip, Button and TextField are native and do get disabled. First seen in batch 7 (2026-10-25): FrequencyPicker's `disabled` (the ended-calendar-routine lock) left the frequency radios live.

**Why:** dimming plus "every control is disabled" in the story looks right, and node-env pure-function tests can't see it.

**How to apply:** in every ported component that receives `disabled` and wraps it in `<fieldset disabled>` or `pointer-events: none`, check that `disabled` is also passed to each DS RadioGroup/Checkbox/Switch. Ask for a jsdom test that clicks the control and asserts no change. Related: [[feedback_dom_predicate_faked_in_node_tests]].

Follow-up trap (same batch, fix round): once each DS control gets `disabled`, it dims itself (Radio, Toggle and Switch use `opacity: 0.45`). A wrapper that still applies MUI-era `opacity: 0.5` (`[data-disabled]` on the section or fieldset) then compounds to about 22%. When the fix lands, check that the wrapper's opacity was removed.
