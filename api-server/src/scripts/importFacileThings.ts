/**
 * One-shot importer: FacileThings XML export → GTD app, writing directly to MongoDB.
 *
 * Usage:
 *   cd api-server
 *   npx tsx --env-file=.env src/scripts/importFacileThings.ts \
 *     --email yuval.gtd.test@gmail.com \
 *     --file /tmp/facilethings_export.xml \
 *     [--dry-run]
 *
 * The script connects to Mongo via the same loader the server uses, ensures the user exists in the
 * Better Auth `user` collection, and inserts items directly into the `items` collection. No API,
 * no tokens, no rate limits.
 *
 * Scope of the import:
 *   - Items: inserted with their final status in one shot.
 *     · Inbox → inbox
 *     · Next Actions → nextAction
 *     · Tickler File → nextAction with ignoreBefore = reminder
 *     · Waiting For → waitingFor
 *     · Calendar / Someday/Maybe / Reference Material → somedayMaybe
 *     · Done → done
 *   - Done items: only those completed in the last 18 months are kept (older ones dropped).
 *   - Routines, People, WorkContexts: SKIPPED. Hashtags and @mentions stay inline in titles.
 *   - Calendar items lose their `timeStart` — they collapse into `somedayMaybe` with the original
 *     reminder recorded in notes.
 *   - All `createdTs` will be the import time; we preserve original FacileThings dates inside notes.
 *
 * Idempotency: every imported item has `externalId = "ft:<index>"`. Re-running upserts on the
 * sparse-unique `(user, externalId)` index — existing rows are replaced in place.
 */

import { readFileSync } from 'node:fs';
import { generateId } from 'better-auth';
import dayjs from 'dayjs';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { ItemInterface, ItemStatus } from '../types/entities.js';

interface CliOptions {
    email: string;
    file: string;
    dryRun: boolean;
}

const DONE_RETAIN_MONTHS = 18;

function parseArgs(argv: string[]): CliOptions {
    const get = (flag: string) => {
        const i = argv.indexOf(flag);
        if (i < 0) return undefined;
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) {
            throw new Error(`Flag ${flag} requires a value`);
        }
        return v;
    };
    const email = get('--email');
    const file = get('--file');
    if (!email) throw new Error('Missing --email');
    if (!file) throw new Error('Missing --file');
    return { email, file, dryRun: argv.includes('--dry-run') };
}

// ---------------- XML parsing ----------------

function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function extractBlocks(xml: string, tag: string): string[] {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
    return [...xml.matchAll(re)].map((m) => m[1] ?? '');
}

function extractField(block: string, tag: string): string | undefined {
    if (new RegExp(`<${tag}\\s*/>`).test(block)) return '';
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
    if (!m) return undefined;
    const v = m[1];
    return v === undefined ? undefined : decodeEntities(v).trim();
}

function stripHtml(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ---------------- Bucket → status mapping ----------------

interface ImportedAction {
    text: string;
    list: string;
    reminder: string | undefined;
    doneAt: string | undefined;
    time: string | undefined;
    energy: string | undefined;
    priority: string | undefined;
    note: string | undefined;
    project: string | undefined;
    area: string | undefined;
    goal: string | undefined;
    routine: string | undefined;
}

function parseAction(block: string): ImportedAction {
    return {
        text: extractField(block, 'text') ?? '',
        list: extractField(block, 'list') ?? '',
        reminder: extractField(block, 'reminder'),
        doneAt: extractField(block, 'done_at'),
        time: extractField(block, 'time'),
        energy: extractField(block, 'energy'),
        priority: extractField(block, 'priority'),
        note: extractField(block, 'note'),
        project: extractField(block, 'project'),
        area: extractField(block, 'area'),
        goal: extractField(block, 'goal'),
        routine: extractField(block, 'routine'),
    };
}

interface PlannedImport {
    externalId: string;
    title: string;
    notes?: string;
    status: ItemStatus;
    extras: {
        time?: number;
        energy?: 'low';
        urgent?: true;
        expectedBy?: string;
        ignoreBefore?: string;
    };
}

function parseFtDateOnly(input: string | undefined): string | undefined {
    if (!input) return undefined;
    const d = dayjs(input);
    if (!d.isValid()) return undefined;
    return d.format('YYYY-MM-DD');
}

function buildNotesFooter(action: ImportedAction): string {
    const parts: string[] = [];
    if (action.reminder) parts.push(`Reminder: ${action.reminder}`);
    if (action.doneAt) parts.push(`Done at: ${action.doneAt}`);
    if (action.list) parts.push(`Original list: ${action.list}`);
    if (action.area) parts.push(`Area: ${action.area}`);
    if (action.project) parts.push(`Project: ${action.project}`);
    if (action.goal) parts.push(`Goal: ${action.goal}`);
    if (action.priority) parts.push(`Priority: ${action.priority}`);
    if (action.energy) parts.push(`Energy: ${action.energy}`);
    if (action.time) parts.push(`Estimate: ${action.time} min`);
    return parts.length > 0 ? `\n\n— Imported from FacileThings —\n${parts.join('\n')}` : '';
}

function planAction(action: ImportedAction, index: number, doneCutoff: dayjs.Dayjs): PlannedImport | null {
    const status = (() => {
        switch (action.list) {
            case 'Inbox':
                return 'inbox';
            case 'Next Actions':
            case 'Tickler File':
                return 'nextAction';
            case 'Waiting For':
                return 'waitingFor';
            case 'Calendar':
            case 'Someday/Maybe':
            case 'Reference Material':
                return 'somedayMaybe';
            case 'Done':
                return 'done';
            default:
                return null;
        }
    })();
    if (!status) return null;
    if (status === 'done' && action.doneAt) {
        const d = dayjs(action.doneAt);
        if (d.isValid() && d.isBefore(doneCutoff)) return null;
    }

    const title = action.text || '(no title)';
    const noteBody = action.note ? stripHtml(action.note) : '';
    const footer = buildNotesFooter(action);
    const notes = `${noteBody}${footer}`.trim() || undefined;

    const minutes = action.time ? Number.parseInt(action.time, 10) : Number.NaN;
    const extras: PlannedImport['extras'] = {};
    if (Number.isFinite(minutes) && minutes > 0) extras.time = minutes;
    if (action.energy === 'low') extras.energy = 'low';
    if (action.priority === 'high') extras.urgent = true;

    if (status === 'nextAction') {
        if (action.list === 'Tickler File') {
            const d = parseFtDateOnly(action.reminder);
            if (d) extras.ignoreBefore = d;
        } else {
            const d = parseFtDateOnly(action.reminder);
            if (d) extras.expectedBy = d;
        }
    }
    if (status === 'waitingFor') {
        const d = parseFtDateOnly(action.reminder);
        if (d) extras.expectedBy = d;
    }

    const externalId = `ft:${index}`;
    const plan: PlannedImport = { externalId, title, status, extras };
    if (notes !== undefined) plan.notes = notes;
    return plan;
}

// ---------------- Bootstrap (DB-side) ----------------

interface StoredUser {
    _id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    image: string | null;
    createdAt: Date;
    updatedAt: Date;
}

async function getOrCreateUser(email: string): Promise<string> {
    const userId = generateId(32);
    const now = dayjs().toDate();
    const result = await db.collection<StoredUser>('user').findOneAndUpdate(
        { email },
        {
            $setOnInsert: {
                _id: userId,
                name: email.split('@')[0],
                email,
                emailVerified: false,
                image: null,
                createdAt: now,
                updatedAt: now,
            } as never,
        },
        { upsert: true, returnDocument: 'after' },
    );
    if (!result) throw new Error('Failed to upsert user');
    return String(result._id);
}

// ---------------- Import ----------------

interface RunCounters {
    plannedTotal: number;
    skipped: number;
    upserted: number;
    replaced: number;
    failed: number;
}

function buildItemDoc(plan: PlannedImport, userId: string, nowIso: string): ItemInterface {
    const doc: ItemInterface = {
        _id: generateId(32),
        user: userId,
        status: plan.status,
        title: plan.title,
        createdTs: nowIso,
        updatedTs: nowIso,
        externalId: plan.externalId,
    };
    if (plan.notes !== undefined) doc.notes = plan.notes;
    const e = plan.extras;
    if (e.time !== undefined) doc.time = e.time;
    if (e.energy !== undefined) doc.energy = e.energy;
    if (e.urgent !== undefined) doc.urgent = e.urgent;
    if (e.expectedBy !== undefined) doc.expectedBy = e.expectedBy;
    if (e.ignoreBefore !== undefined) doc.ignoreBefore = e.ignoreBefore;
    return doc;
}

async function importDirect(plans: PlannedImport[], userId: string, counters: RunCounters) {
    const nowIso = dayjs().toISOString();
    let processed = 0;
    for (const plan of plans) {
        processed++;
        const doc = buildItemDoc(plan, userId, nowIso);
        try {
            // Upsert by (user, externalId): re-running the import replaces the row in place.
            // We can't use `replaceById` because the _id we just generated won't match an existing
            // row from a prior run; the externalId is the stable identity here.
            const res = await itemsDAO.updateOne({ user: userId, externalId: plan.externalId }, { $set: doc as never }, { upsert: true });
            if (res.upsertedCount > 0) {
                counters.upserted++;
            } else {
                counters.replaced++;
            }
        } catch (err) {
            counters.failed++;
            console.warn(`  ! upsert failed externalId=${plan.externalId}: ${(err as Error).message}`);
        }
        if (processed % 200 === 0) console.log(`  upsert: ${processed}/${plans.length}`);
    }
}

async function run() {
    const opts = parseArgs(process.argv.slice(2));
    const xml = readFileSync(opts.file, 'utf-8');

    await loadDataAccess();

    const userId = await getOrCreateUser(opts.email);
    console.log(`User: ${opts.email} → ${userId}`);

    // Build the plan from XML.
    const actionsBlock = /<actions>([\s\S]*)<\/actions>/.exec(xml)?.[1] ?? '';
    const actionBlocks = extractBlocks(actionsBlock, 'action');
    console.log(`Found ${actionBlocks.length} actions`);
    const doneCutoff = dayjs().subtract(DONE_RETAIN_MONTHS, 'month');
    const plans: PlannedImport[] = [];
    for (let i = 0; i < actionBlocks.length; i++) {
        const plan = planAction(parseAction(actionBlocks[i] ?? ''), i, doneCutoff);
        if (plan) plans.push(plan);
    }
    const skipped = actionBlocks.length - plans.length;

    const routinesBlock = /<routines>([\s\S]*)<\/routines>/.exec(xml)?.[1] ?? '';
    const routineCount = extractBlocks(routinesBlock, 'routine').length;

    console.log(`Plan: ${plans.length} items to import (skipped ${skipped} older Done items + non-action rows)`);
    console.log(`Note: skipping ${routineCount} routines, all people, and all work contexts.`);

    const counters: RunCounters = {
        plannedTotal: plans.length,
        skipped,
        upserted: 0,
        replaced: 0,
        failed: 0,
    };

    if (!opts.dryRun) {
        await importDirect(plans, userId, counters);
    } else {
        console.log('[dry-run] skipping DB writes.');
    }

    console.log('\n=== Import summary ===');
    console.log(JSON.stringify(counters, null, 2));

    await closeDataAccess();
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
