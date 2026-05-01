// One-shot cleanup for e2e-leaked calendar seeds in gtd_dev.
//
// Why this exists: every e2e spec that calls /dev/calendar/seed-integration leaves a
// `calendarIntegrations` row + one or more `calendarSyncConfigs` rows behind. Each row carries an
// encrypted-but-fake refresh token (`'dev-rt-plaintext'`), so the hourly webhook-renewal cron
// hammers Google with refresh attempts that all 401 — drowning the dev server log in stack traces.
//
// Detection signal: real OAuth refresh tokens are ~264 chars after encryption (28-char IV + 32-char
// auth tag + ciphertext for ~150-byte plaintext). The fake `'dev-rt-plaintext'` (16 bytes) encrypts
// to exactly 90 chars (28-char IV + 32-char auth tag + 30-char ciphertext, format `iv:tag:ct`).
// We treat any integration with a 90-char refreshToken as a seed and remove it + its configs +
// any items linked exclusively to it.
//
// Run with:
//   mongosh "$MONGO_DB_URL/$MONGO_DB_NAME" --quiet --file e2e/scripts/cleanupE2ECalendarSeeds.js
// Defaults to mongodb://127.0.0.1:27017/gtd_dev when invoked via `npm run cleanup-e2e-seeds`.

const FAKE_REFRESH_TOKEN_LEN = 90;

print(`[cleanup-e2e-seeds] db=${db.getName()}`);
print(
    `[cleanup-e2e-seeds] before: integrations=${db.calendarIntegrations.countDocuments({})}, syncConfigs=${db.calendarSyncConfigs.countDocuments({})}, items.calendarLinked=${db.items.countDocuments({ calendarIntegrationId: { $exists: true, $ne: null } })}`,
);

const fakeIntegrationIds = db.calendarIntegrations
    .find({ $expr: { $eq: [{ $strLenCP: '$refreshToken' }, FAKE_REFRESH_TOKEN_LEN] } }, { _id: 1 })
    .toArray()
    .map((d) => d._id);

if (fakeIntegrationIds.length === 0) {
    print('[cleanup-e2e-seeds] no fake integrations found — nothing to do');
    quit();
}

print(`[cleanup-e2e-seeds] identified ${fakeIntegrationIds.length} fake integrations (refreshToken length === ${FAKE_REFRESH_TOKEN_LEN})`);

// Delete configs first (they reference integrations).
const configsResult = db.calendarSyncConfigs.deleteMany({ integrationId: { $in: fakeIntegrationIds } });
print(`[cleanup-e2e-seeds] deleted ${configsResult.deletedCount} sync configs`);

// Delete items linked to fake integrations. These are e2e-seeded calendar items that would be
// orphaned otherwise. Excludes items not linked to any integration (purely local items survive).
const itemsResult = db.items.deleteMany({ calendarIntegrationId: { $in: fakeIntegrationIds } });
print(`[cleanup-e2e-seeds] deleted ${itemsResult.deletedCount} linked items`);

// Delete the integrations themselves.
const integrationsResult = db.calendarIntegrations.deleteMany({ _id: { $in: fakeIntegrationIds } });
print(`[cleanup-e2e-seeds] deleted ${integrationsResult.deletedCount} integrations`);

// Drop matching webhook-renewal-driving sentEmails too — they reference fake integrations and
// otherwise just waste rows. Optional; comment out if you want to preserve the audit trail.
const emailsResult = db.sentEmails.deleteMany({ kind: { $in: ['calendar_auth_warning', 'calendar_auth_revoked'] } });
print(`[cleanup-e2e-seeds] deleted ${emailsResult.deletedCount} stale sentEmails (calendar auth)`);

print(
    `[cleanup-e2e-seeds] after:  integrations=${db.calendarIntegrations.countDocuments({})}, syncConfigs=${db.calendarSyncConfigs.countDocuments({})}, items.calendarLinked=${db.items.countDocuments({ calendarIntegrationId: { $exists: true, $ne: null } })}`,
);
print('[cleanup-e2e-seeds] done');
