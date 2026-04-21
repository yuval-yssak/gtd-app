# Calendar Routine ↔ GCal Sync Audit

End-to-end audit of the sync behaviour documented in [`docs/CALENDAR_ROUTINE_SYNC_TESTS.md`](../../../docs/CALENDAR_ROUTINE_SYNC_TESTS.md).

**No mocks.** Every scenario runs against:
- a real MongoDB test database (`gtd_test_sync_audit`)
- a real Google account's calendar, via googleapis

Sync is triggered by calling `POST /calendar/integrations/:id/sync` directly — webhook delivery is bypassed so runs are deterministic.

## One-time setup

1. Create (or reuse) a **dedicated throwaway Google account**. Do not use your main account — the audit creates and deletes real calendar events.
2. In the Google Cloud project that owns `GOOGLE_OAUTH_APP_CLIENT_ID` / `GOOGLE_OAUTH_APP_CLIENT_SECRET`, add `http://localhost:4466/callback` as an **Authorized redirect URI** on the OAuth client. (This URI is used only by the setup script — the main app still uses `BETTER_AUTH_URL/calendar/auth/google/callback`.)
3. Ensure the Google Calendar scope is on the OAuth consent screen.
4. Run the setup script:
   ```
   cd api-server
   npm run test:sync-audit:setup
   ```
   Open the printed URL, authorize the test account, and the script will write `src/tests-sync-audit/.secrets/gcal-e2e.json` (gitignored).

The refresh token stored there is long-lived (~6 months). When it eventually stops working, re-run the setup script.

## Running the audit

```
cd api-server
npm run test:sync-audit
```

The run:
1. Seeds a test user, integration, and sync config in `gtd_test_sync_audit`.
2. Defensively cleans any leftover events in the test calendar tagged with this run's id.
3. Executes each scenario — creating/reading/modifying routines on the app side and events on the GCal side.
4. Runs cleanup again after the last scenario.
5. Writes `src/tests-sync-audit/reports/sync-audit-<timestamp>.md`.

The report has one row per scenario with pass/fail/skip, duration, and the first error line for any failure.

## Gotchas

- **Google API rate limits** — each scenario makes ~5-10 calls. Don't run in a tight loop.
- **Webhooks are never registered** by the audit — the sync route's webhook-renewal branch is a no-op with no prior channel. (Covered separately by the unit tests in `src/tests/calendar.test.ts`.)
- **`CALENDAR_ENCRYPTION_KEY`** — the integration stored in Mongo must be decryptable by the server. The audit uses the same env-derived key as the app, so if `.env` has no `CALENDAR_ENCRYPTION_KEY`, both setup and audit fall back to the same deterministic dev key (see `src/lib/tokenEncryption.ts`).
- **Scenarios needing a browser** (offline flush, client-side splits) are marked `.skip` and listed in the report as `⊘ skip`. Those will be added in a later phase via Playwright.

## Scope

Implemented for server-side flows:
- Section A: app-originated routine, app-side change (time, title, trash, master edit, delete)
- Section B: app-originated routine, GCal-side change (instance edit, master edit, master delete)
- Section I: routine deactivation (master deleted in GCal)

Marked skipped pending Playwright layer:
- Section C: GCal-originated routine + app-side change — needs `generateCalendarItemsToHorizon`
- Section E: "this and following" splits — client-side logic
- Section A9: offline flush — needs client queue

## Debugging

If a scenario fails:
1. Look at the report's `## Failures` section — it includes the first error line.
2. Re-run with `vitest run --config vitest.sync-audit.config.ts <scenario-file>` to rerun just that file.
3. Open the test calendar in GCal (as the test account) and inspect the event tagged with the run id shown in the console output.
