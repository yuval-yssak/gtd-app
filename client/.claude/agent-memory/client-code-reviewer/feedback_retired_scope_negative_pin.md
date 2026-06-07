---
name: retired-scope-negative-pin
description: When a value is removed from a TS union (e.g. an API token scope), keep the negative "must not appear" test, don't swap it for a weaker positive assertion
metadata:
  type: feedback
---

When a literal is retired from a TS string-union (e.g. an `ApiTokenScope` like `items.clarify`), the PR often replaces the old negative invariant test (`expect(SET).not.toContain('X')`) with a weaker positive one (`expect(SET).toContain('replacement')`). Push back: keep a negative pin asserting the retired value is gone.

**Why:** the genuinely new invariant created by a removal is "X is no longer present" — a positive assertion on the replacement still passes if X is accidentally re-added. The replacement was usually already covered elsewhere.

**How to apply:** after removal, `.not.toContain<Union>('X')` no longer type-checks (literal gone from union) — drop the generic arg and assert on a plain string: `.not.toContain('X')`. That out-of-union string assertion is correct and belongs in tests.

Also pair with a render-level test for any data that crosses the network boundary: fields typed as `Union[]` (e.g. `PersonalApiToken.scopes`) are populated from untyped JSON, so a legacy/out-of-union value can still arrive at runtime. The type system gives zero protection there — verify the UI (e.g. raw-string chip via `label={scope}`) tolerates it. See [[react-keys-by-display-name]] for the related lossy-string pattern.
