# GTD App

A full-stack offline-first productivity app implementing the [Getting Things Done](https://gettingthingsdone.com/) methodology.

Items flow through four phases — **Collect → Clarify → Review → Do** — across statuses (`inbox`, `nextAction`, `calendar`, `waitingFor`, `done`, `trash`), with support for routines, work contexts, people, and bidirectional Google Calendar sync. All mutations are queued as operations and synced across devices with last-write-wins conflict resolution.

## Version Identification

Every build is stamped with the git short commit hash so you can verify that the browser, server, and local repo are all running the same code.

| Where | How to check |
|---|---|
| Local repo | `git rev-parse --short HEAD` |
| Browser | Settings → App section → "Version: abc1234" |
| API server | `GET /version` → `{ "commitHash": "abc1234" }` (also logged at startup) |

The hash is injected at build time — via Vite `define` for the client and a Docker build arg (`COMMIT_HASH`) for the API server.

---

- **Data model & sync architecture**: [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md)
- **Public API**: [`docs/PUBLIC_API.md`](docs/PUBLIC_API.md)
- **Google Calendar sync internals** (pushback, escalation, "Sync now" sweep): [`api-server/README.md`](api-server/README.md) § Calendar Integration; test matrix in [`docs/CALENDAR_ROUTINE_SYNC_TESTS.md`](docs/CALENDAR_ROUTINE_SYNC_TESTS.md)
- **Design plans** (in-flight and shipped): [`docs/plans/`](docs/plans/) — each file states its status at the top
- **Dev setup & architecture**: [`api-server/CLAUDE.md`](api-server/CLAUDE.md)
- **Full project overview**: [`CLAUDE.md`](CLAUDE.md)
