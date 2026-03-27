# GTD App

A full-stack offline-first productivity app implementing the [Getting Things Done](https://gettingthingsdone.com/) methodology.

Items flow through four phases — **Collect → Clarify → Review → Do** — across statuses (`inbox`, `nextAction`, `calendar`, `waitingFor`, `done`, `trash`), with support for routines, work contexts, people, and bidirectional Google Calendar sync. All mutations are queued as operations and synced across devices with last-write-wins conflict resolution.

- **Data model & sync architecture**: [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md)
- **Dev setup & architecture**: [`api-server/CLAUDE.md`](api-server/CLAUDE.md)
- **Full project overview**: [`CLAUDE.md`](CLAUDE.md)
