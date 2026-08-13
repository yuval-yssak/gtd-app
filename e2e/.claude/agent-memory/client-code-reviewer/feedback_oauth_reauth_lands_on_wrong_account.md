---
name: oauth-reauth-lands-on-wrong-account
description: Re-login redirects omit prompt=select_account, so OAuth can complete as a different Google account than the flagged one — any post-callback action keyed on session.user.id then targets the wrong account.
metadata:
  type: feedback
---

`reauthForUserId` in `hooks/useAccounts.ts` kicks off `authClient.signIn.social(...)` **without** appending `prompt=select_account`, unlike `addAnotherAccount` which appends it explicitly (with a comment noting Google otherwise auto-selects the current signed-in account and completes instantly with no picker).

Consequence: on a multi-account device, clicking "Re-login" for account A can complete OAuth as account B. Anything in `routes/auth.callback.tsx` keyed on `session.user.id` therefore acts on B, not A — the account that was actually broken stays broken, and side effects (clearing warning state, announcing resolution cross-tab) are applied to an account that was never in trouble.

**Why:** the intended target userId is known at redirect time but is dropped on the floor; the callback can only see whoever Google decided to log in. Nothing in the flow validates that they match.

**How to apply:** whenever a review adds a new side effect to `auth.callback.tsx`'s `beforeLoad` keyed on `session.user.id`, require that the intended userId is carried through the round-trip (e.g. a `?reauthFor=` search param on `callbackURL`) and that the side effect is gated on `session.user.id === intendedUserId`. Also flag the missing `prompt=select_account` on any re-auth redirect. Related: [[self-heal-clear-races-flag-setters]].
