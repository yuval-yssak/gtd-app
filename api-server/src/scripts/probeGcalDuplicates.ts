/**
 * READ-ONLY probe: lists events on a Google Calendar over a window and reports duplicate groups
 * (same title + same start time, two or more distinct event ids / masters). This surfaces the
 * duplicate-events-on-Google the user sees in their browser — distinct from app-side duplicates.
 * No writes.
 *
 * Usage (staging):
 *   cd api-server
 *   MONGO_DB_URL='<uri>' MONGO_DB_NAME=gtdStagingDB \
 *     npx tsx src/scripts/probeGcalDuplicates.ts --user <userId> --integration <integrationId> --calendar <calendarId> [--days 60]
 */

import dayjs from 'dayjs';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import { buildCalendarProvider } from '../lib/buildCalendarProvider.js';
import { closeDataAccess, loadDataAccess } from '../loaders/mainLoader.js';

function arg(flag: string): string | undefined {
    const i = process.argv.indexOf(flag);
    return i < 0 ? undefined : process.argv[i + 1];
}

async function run(): Promise<void> {
    const userId = arg('--user');
    const integrationId = arg('--integration');
    const calendarId = arg('--calendar');
    const days = Number(arg('--days') ?? '60');
    if (!userId || !integrationId || !calendarId) {
        throw new Error('Usage: --user <userId> --integration <integrationId> --calendar <calendarId> [--days N]');
    }
    await loadDataAccess();
    try {
        const integration = (await calendarIntegrationsDAO.findByUserDecrypted(userId)).find((i) => i._id === integrationId);
        if (!integration) {
            throw new Error(`integration ${integrationId} not found for user`);
        }
        const provider = buildCalendarProvider(integration, userId);
        const since = dayjs().subtract(7, 'day').toISOString();
        const until = dayjs().add(days, 'day').toISOString();
        const events = (await provider.listEvents(calendarId, since, until)).filter((e) => e.status !== 'cancelled');
        console.log(`Window ${since} .. ${until} on ${calendarId}`);
        console.log(`Live events: ${events.length}\n`);

        const byKey = new Map<string, typeof events>();
        for (const e of events) {
            const key = `${e.title}|${e.timeStart}`;
            byKey.set(key, [...(byKey.get(key) ?? []), e]);
        }
        const dups = [...byKey.entries()].filter(([, v]) => v.length > 1);
        console.log(`Duplicate (title+start) groups: ${dups.length}\n`);
        for (const [key, group] of dups) {
            console.log(`  ${key}  ×${group.length}`);
            for (const e of group) {
                console.log(`      id=${e.id} master=${e.recurringEventId ?? '-'}`);
            }
        }

        // Collapse each event to its base master id (strip the _R<anchor> split-successor suffix), then
        // split per title into gtd* clone masters vs real masters. A gtd* clone is SAFE to delete only
        // when a real master for the same title also exists (else it is the meeting's only copy).
        const baseMaster = (e: (typeof events)[number]): string => (e.recurringEventId ?? e.id).split('_R')[0] ?? e.recurringEventId ?? e.id;
        const realByTitle = new Map<string, Set<string>>();
        const gtdByTitle = new Map<string, Set<string>>();
        for (const e of events) {
            const base = baseMaster(e);
            const target = base.startsWith('gtd') ? gtdByTitle : realByTitle;
            target.set(e.title, (target.get(e.title) ?? new Set()).add(base));
        }
        console.log('\n=== gtd* clone masters (SAFE = a real master for the same title also exists) ===');
        let safe = 0;
        let onlyCopy = 0;
        for (const [title, gset] of gtdByTitle) {
            const hasReal = (realByTitle.get(title)?.size ?? 0) > 0;
            for (const g of gset) {
                hasReal ? safe++ : onlyCopy++;
                console.log(`  ${hasReal ? 'SAFE      ' : '!!ONLY-COPY'} | "${title}" | ${g}`);
            }
        }
        console.log(`\nclone masters: ${safe} SAFE-to-delete, ${onlyCopy} ONLY-COPY (must keep / re-point)`);
    } finally {
        await closeDataAccess();
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
