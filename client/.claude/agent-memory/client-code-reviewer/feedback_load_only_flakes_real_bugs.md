---
name: load-only-e2e-flakes-can-be-real-bugs
description: Load-only e2e flakes in this repo have turned out to be real app bugs whose guard assertion sits right on a geometric boundary (the fold); demand a deterministic setup
metadata:
  type: feedback
---
Some e2e failures that only show up at high parallelism are real app bugs, not test timing. Example from 2026-10-30: `.srOnly` absolute spans had no positioned scrollport, so the document grew scroll height whenever the spans were laid out below the fold. At the default 720px viewport the spans sat at y≈701, so the test only failed when a loaded machine rendered the card ~30px taller. I first guessed the cause was item order; instrumenting showed it was the fold boundary. The fix was a 640px viewport, so the spans are below the fold on every machine, plus running the guard on both items.

**Why:** an assertion whose trigger sits a few pixels from a layout threshold passes or fails with render timing and font metrics, so a real bug looks like load-dependent flakiness.

**How to apply:** when a layout fix is justified by a flaky spec, ask the author to measure where the trigger element actually lands (instrument it), and require a setup that puts it clearly past the threshold, plus a run with the fix removed that fails every time at --workers=1. Don't present a guess about the cause as settled. See [[prove-layout-fixes-geometrically]].
