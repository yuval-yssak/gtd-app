---
name: focus-restore-clears-record-on-text-fields
description: Focus-restoration hooks that record "the last focused control" clear the record whenever focus enters a testid-less text field, so the Escape-from-a-text-field transition — the commonest keyboard path — is the one case left stranded on <body>
metadata:
  type: feedback
---

A "keep keyboard focus alive across transitions" hook records the focused control on `focusin` and
restores after it disconnects. The anti-staleness rule ("clear the record when the newly focused
element carries no data-testid, so it can't point at a control the user left") is correct in intent
but silently drops the most frequent transition: the user types in a text field, presses Escape,
the field unmounts with its card, and the record is already `null` — nothing restores.

**Why:** the hook's authors reason about button→button transitions, which is where the reported bug
was seen. Text fields are treated as "not a control" for recording purposes, and nobody re-checks
what happens when a transition starts *from* one. Under `chrome='page'` the replacement editor
autofocuses nothing, so the fallback is genuinely `<body>`.

**How to apply:** for any focus-restoration diff, enumerate the transitions by *where focus was*,
not by *what changed*: button→remount, button→stage swap, AND text-field→Escape/skip. Check whether
the recording rule can produce a null record on any of them. The fix shape is to keep a separate
disconnection sentinel (`event.target.closest('[data-testid]')`) so a testid-less focus still has
something to detect the unmount with. Also check the e2e: existing Escape assertions usually assert
the resulting view and say nothing about focus. Related:
[[conditional-render-gate-loses-coverage]].
