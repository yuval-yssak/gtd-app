/**
 * Audit script — replays recent ops from a Mongo database through `validateOperation` and prints
 * violations grouped by status × field. Used to discover client-side contract violations before
 * `/sync/push` flips to strict-mode validation.
 *
 * Usage:
 *   cd api-server
 *   MONGO_DB_URL="mongodb+srv://…" MONGO_DB_NAME="gtd_staging" \
 *     npx tsx src/scripts/auditSyncOps.ts [--days 30] [--limit 100000] [--user <userId>]
 *
 * Connection string for staging lives in 1Password ("Database - GTD staging"). Credentials are
 * read-only for this script (only needs `find` on the `operations` collection).
 *
 * Exit code is 0 even when violations are found — this is an audit, not a gate. The output is
 * aggregated tables of (status, field, count) for items and (entityType, code, count) for other
 * entities.
 */

import dayjs from 'dayjs';
import { MongoClient } from 'mongodb';
import { type ValidationFailure, validateOperation } from '../schemas/operations/index.js';
import type { OperationInterface } from '../types/entities.js';

interface CliOptions {
    days: number;
    limit: number;
    user?: string;
}

function parseArgs(argv: string[]): CliOptions {
    const get = (flag: string) => {
        const i = argv.indexOf(flag);
        if (i < 0) return undefined;
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`Flag ${flag} requires a value`);
        }
        return value;
    };
    const days = Number(get('--days') ?? '30');
    const limit = Number(get('--limit') ?? '100000');
    const user = get('--user');
    if (!Number.isFinite(days) || days < 1) throw new Error('--days must be a positive integer');
    if (!Number.isFinite(limit) || limit < 1) throw new Error('--limit must be a positive integer');
    return { days, limit, ...(user !== undefined ? { user } : {}) };
}

interface ViolationBucket {
    count: number;
    examples: Array<{ entityId: string; ts: string }>;
}

interface AuditResult {
    scanned: number;
    valid: number;
    structural: number;
    matrix: number;
    // Item status×field heatmap.
    matrixByCell: Map<string, ViolationBucket>;
    // Structural failures grouped by (entityType, code).
    structuralByKey: Map<string, ViolationBucket>;
}

function emptyResult(): AuditResult {
    return {
        scanned: 0,
        valid: 0,
        structural: 0,
        matrix: 0,
        matrixByCell: new Map(),
        structuralByKey: new Map(),
    };
}

function bumpBucket(map: Map<string, ViolationBucket>, key: string, op: OperationInterface): void {
    const bucket = map.get(key) ?? { count: 0, examples: [] };
    bucket.count += 1;
    if (bucket.examples.length < 5) {
        bucket.examples.push({ entityId: op.entityId, ts: op.ts });
    }
    map.set(key, bucket);
}

function recordFailure(result: AuditResult, op: OperationInterface, failure: ValidationFailure): void {
    if (failure.code === 'status_field_violation') {
        result.matrix += 1;
        const cell = `${failure.extra?.status ?? '?'}:${failure.extra?.field ?? '?'}`;
        bumpBucket(result.matrixByCell, cell, op);
        return;
    }
    result.structural += 1;
    const key = `${op.entityType}:${op.opType}:${failure.message}`;
    bumpBucket(result.structuralByKey, key, op);
}

function printHeatmap(map: Map<string, ViolationBucket>, title: string): void {
    if (map.size === 0) return;
    console.log(`\n=== ${title} ===`);
    const rows = Array.from(map.entries()).sort(([, a], [, b]) => b.count - a.count);
    for (const [key, bucket] of rows) {
        console.log(`  ${bucket.count.toString().padStart(6)}  ${key}`);
        for (const ex of bucket.examples) {
            console.log(`           ↳ ${ex.entityId} @ ${ex.ts}`);
        }
    }
}

async function run(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2));
    const url = process.env.MONGO_DB_URL;
    const dbName = process.env.MONGO_DB_NAME;
    if (!url || !dbName) {
        console.error('Set MONGO_DB_URL and MONGO_DB_NAME (1Password: "Database - GTD staging")');
        process.exit(1);
    }
    const client = new MongoClient(url);
    await client.connect();
    try {
        const collection = client.db(dbName).collection<OperationInterface>('operations');
        const cutoff = dayjs().subtract(opts.days, 'day').toISOString();
        const filter: { ts: { $gte: string }; user?: string } = { ts: { $gte: cutoff } };
        if (opts.user) filter.user = opts.user;
        console.log(`Scanning ops since ${cutoff}${opts.user ? ` for user=${opts.user}` : ''}, limit ${opts.limit}…`);

        const cursor = collection.find(filter, { sort: { ts: 1 }, limit: opts.limit });
        const result = emptyResult();

        for await (const op of cursor) {
            result.scanned += 1;
            // Audit input mirrors the validator's expected shape — entityType/entityId/opType/snapshot.
            // The persisted op carries server-only fields (_id, user, ts, deviceId) that aren't part
            // of the contract; we strip them before validating.
            const validation = validateOperation({
                entityType: op.entityType,
                entityId: op.entityId,
                opType: op.opType,
                snapshot: op.snapshot,
            });
            if (validation.ok) {
                result.valid += 1;
                continue;
            }
            recordFailure(result, op, validation);
        }

        console.log(`\nScanned ${result.scanned} ops`);
        console.log(`  valid:                ${result.valid}`);
        console.log(`  status×field matrix:  ${result.matrix}`);
        console.log(`  structural failures:  ${result.structural}`);
        printHeatmap(result.matrixByCell, 'Item status × field violations (the new strict rule)');
        printHeatmap(result.structuralByKey, 'Structural failures (entityType:opType:message)');
    } finally {
        await client.close();
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
