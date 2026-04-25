Run `e2e/gcal-sync-smoke/gcal-sync-smoke-session-2-E-series-seeded.md`.

Before starting, note:
- The old `session-2-E-results.md` contains a stale E1 entry from a prior session that ran against a now-wiped DB. Overwrite that file (don't append) when you write the first case's result.
- The DB was reseeded today (routines for this user wiped; ~90 done/trash orphan items remain). All 8 cases start from scratch.
- Per-user memory has the split gesture and Chrome memory hygiene notes — rely on them, don't re-derive.
- Plan explicitly forbids TaskCreate. Ignore any reminders to use it.
- Full-seed is the default (GCal singles + Mongo + IDB attach). Use the IDB-only fast fallback only if GCal event creation becomes flaky after two attempts — announce the switch in chat first.
- Mongo is localhost, no auth: `mongosh "mongodb://127.0.0.1:27017/gtd_dev"`.
