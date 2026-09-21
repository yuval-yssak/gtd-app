---
name: visible-state-vs-silent-outcome
description: Features fix "the UI is silent" by adding a rendered STATE, but leave the ACTION that produces that state (the generate/retry click) still silent — the gap just moves to the retry path
metadata:
  type: project
---

When a "silence is not fine" UX bug is fixed, the fix consistently lands on the **derived render
state** (a new `BriefState` variant, a new banner flag) and consistently **misses the imperative
action** that produces it. The action's feedback layer keys on a coarse server `outcome` string
and never re-reads the payload, so a result that is semantically "I did nothing" is reported as
success-with-no-message.

Concrete instance (2026-09-21, `declined` brief state): `briefState()` gained `'declined'` so a
`text: null` row renders a caption instead of a blank field — but `describeGenerateOutcome()` still
maps `outcome: 'written'` to `null` (silent). The server returns `outcome: 'written'` with
`brief.text === null` when the model declines. First click is *incidentally* visible (the caption
appears as a side effect of the state flip); the **retry** click — the exact gesture the feature
deliberately kept labelled "Generate" — changes nothing on screen and shows no snackbar. The
original bug, relocated.

**Why:** the outcome enum was designed before the null-text case was a first-class state, and the
"was a brief written?" question is answered by the enum rather than by the returned row.

**How to apply:** whenever a change introduces a new *rendered* state for "the server deliberately
did nothing", trace the button/action that can produce it and ask what the user sees when the
action is a **no-op repeat** (state already equals the new state). Check whether the feedback
function branches on the payload (`result.brief.text`) or only on the outcome enum. Also check for
the inverse: a snackbar and a new caption firing together and saying the same sentence twice.

Related: [[uncommitted-text-vs-server-ai-call]], [[event-banner-component-untested]]
