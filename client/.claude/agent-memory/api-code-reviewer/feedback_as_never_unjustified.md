---
name: as never on Mongo Filter casts
description: `as never` casts often pasted onto Mongo filters but are unjustified when Filter<S> already accepts the operators — usually copy-pasta from one or two legacy spots
type: feedback
---

Several spots in the api-server cast Mongo args with `as never`:
- `itemsDAO.findOne({...} as never)`
- `itemsDAO.findArray({...} as never)`
- `db.collection<T>(...).findOne({...} as never)`
- **update operators too**: `coll.updateMany({...}, { $addToSet: {...} } as never)` / `{ $pull: {...} } as never` (seen in `loaders/apiTokenScopeMigration.ts`)

In most of these, the cast is unnecessary — the DAO's `findOne(filter: Filter<S>)` and `findArray(filter: Filter<S>)` accept Mongo's `Filter<>` type which already supports `$nin`, `$gte`, `$or`, etc. For updates, `$addToSet`/`$pull` against a plain `string[]` field are valid `UpdateFilter<S>` operators and need no cast. The `as never` propagates by copy-paste — the boot-migration files are the worst offenders. `deviceSyncStateMigration.ts` has ONE legitimately-cast spot (`$not: /::/` on `_id`), and that one legit cast tends to get pasted onto every other line in the same file that doesn't need it.

**Why:** CLAUDE.md "TypeScript" rule — "Type assertions must be rare and justified." Each cast hides a possible real type error from the compiler. Reviewers should treat `as never` as a code smell, not a normal pattern, and ask "does this filter actually fail to type-check without the cast?".

**How to apply:** When you see `as never` on a Mongo filter, mentally remove it and ask whether the call would still type-check. If yes, flag as a Standards Violation. If no, ask for a comment explaining what's narrowed — usually it's because the filter mixes `_id` with `user` and the DAO's generic doesn't include `_id` directly.
