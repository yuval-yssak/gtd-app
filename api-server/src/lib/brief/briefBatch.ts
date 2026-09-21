import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import dayjs from 'dayjs';
import briefBatchesDAO from '../../dataAccess/briefBatchesDAO.js';
import briefBatchRequestsDAO from '../../dataAccess/briefBatchRequestsDAO.js';
import type { BriefBatchInterface, BriefBatchRequestInterface, BriefBatchResultCounts } from '../../types/entities.js';
import { getAnthropicClient } from '../claude/anthropicClient.js';
import { BriefGenerationError, parseBriefResponse } from './briefModel.js';
import { executePlansSerially, type ModelPlan, partitionPlans } from './briefPlans.js';
import { BRIEF_MODEL, buildBriefRequest } from './briefPrompt.js';
import { findBriefTargets } from './briefTargets.js';
import { writeModelBrief } from './briefWriter.js';

/**
 * Message Batches pipeline (docs/plans/item-brief.md § 3.1): the primary, cheapest generation
 * path. `submitBriefBatch` turns the sweep's targets into ONE batch (skip-rule targets are settled
 * locally, never sent); `harvestBriefBatches` drains ended batches into compare-and-set writes.
 * Both are driven by `POST /maintenance/briefs/sweep` every ~15 minutes from Cloud Scheduler.
 */

export const BRIEF_BATCH_DEVICE_ID = 'server:brief-batch';
export const BRIEF_BATCH_DEFAULT_LIMIT = 2000;
/** Anthropic expires a batch 24 h after creation; two hours of slack cover a late `ended`. */
export const BRIEF_BATCH_EXPIRY_HOURS = 26;
/** Request rows outlive the batch expiry ceiling comfortably, then the TTL reaps any stranded ones. */
export const BRIEF_BATCH_REQUEST_TTL_HOURS = 48;
/** Harvested/expired/failed batch rows stay as an audit trail for this long. */
export const BRIEF_BATCH_ROW_TTL_DAYS = 90;
const LOG_PREFIX = '[brief-batch]';

export interface SubmitBriefBatchSummary {
    /** Requests sent to Anthropic — or, under `BRIEF_FAKE_MODEL=1`, briefs generated directly. */
    submitted: number;
    /** Skip-rule rows written locally (notes too short); never part of a batch. */
    skipped: number;
    /** A batch was already `processing`, so nothing was selected or sent. */
    inFlight: boolean;
    batchId?: string;
    fake?: true;
}

export interface HarvestBriefBatchesSummary {
    harvested: number;
    /** Still `processing` at Anthropic — checked again next sweep. */
    pending: number;
    expired: number;
    /** Anthropic no longer knows the batch (results are retained ~29 days) — marked `failed`. */
    failed: number;
    /** Transient retrieve/stream errors; the row stays `processing` for the next sweep. */
    errors: number;
    resultCounts: BriefBatchResultCounts;
}

function emptyCounts(): BriefBatchResultCounts {
    return { succeeded: 0, errored: 0, canceled: 0, expired: 0, discardedStale: 0, pinned: 0, written: 0 };
}

function addCounts(a: BriefBatchResultCounts, b: BriefBatchResultCounts): BriefBatchResultCounts {
    return {
        succeeded: a.succeeded + b.succeeded,
        errored: a.errored + b.errored,
        canceled: a.canceled + b.canceled,
        expired: a.expired + b.expired,
        discardedStale: a.discardedStale + b.discardedStale,
        pinned: a.pinned + b.pinned,
        written: a.written + b.written,
    };
}

// ── custom_id ──────────────────────────────────────────────────────────────

/** Anthropic's `custom_id` contract: 1–64 chars of `[A-Za-z0-9_-]`, unique within the batch. */
export const CUSTOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * An opaque 32-hex token. The (user, item, sourceHash) identity does not fit the 64-char limit
 * (nor its charset — ids may carry `:`), so it lives in a `briefBatchRequests` row keyed by this.
 */
export function newBriefCustomId(): string {
    return randomUUID().replaceAll('-', '');
}

interface BatchEntry {
    plan: ModelPlan;
    customId: string;
    request: Anthropic.Messages.Batches.BatchCreateParams.Request;
}

/** The plan travels with its request so the row insert never re-derives the pairing by index. */
function toBatchEntry(plan: ModelPlan): BatchEntry {
    const customId = newBriefCustomId();
    return { plan, customId, request: { custom_id: customId, params: buildBriefRequest(plan.item) } };
}

function toRequestRow(batchId: string, { plan, customId }: BatchEntry, created: dayjs.Dayjs): BriefBatchRequestInterface {
    return {
        _id: customId,
        batchId,
        user: plan.item.user,
        itemId: plan.item._id,
        sourceHash: plan.sourceHash,
        createdTs: created.toISOString(),
        expiresAt: created.add(BRIEF_BATCH_REQUEST_TTL_HOURS, 'hour').toDate(),
    };
}

/**
 * Creates the batch at Anthropic, then persists its request identities, then the batch row LAST —
 * so a `processing` row always has its requests. A crash in between orphans the batch upstream
 * (its targets stay stale and are resubmitted by a later sweep) and strands the request rows,
 * which the DAO's TTL index reaps.
 */
async function createBatch(models: ModelPlan[]): Promise<string> {
    const entries = models.map(toBatchEntry);
    const batch = await getAnthropicClient().messages.batches.create({ requests: entries.map((entry) => entry.request) });
    const created = dayjs();
    await briefBatchRequestsDAO.insertMany(entries.map((entry) => toRequestRow(batch.id, entry, created)));
    const row: BriefBatchInterface = {
        _id: batch.id,
        createdTs: created.toISOString(),
        submittedCount: models.length,
        status: 'processing',
        expiresAt: created.add(BRIEF_BATCH_ROW_TTL_DAYS, 'day').toDate(),
    };
    await briefBatchesDAO.insertOne(row);
    return batch.id;
}

function isFakeModel(): boolean {
    return process.env.BRIEF_FAKE_MODEL === '1';
}

/**
 * One sweep's submission. Skip-rule targets are written immediately (no request); the rest become
 * one batch. Refuses while a batch is still `processing` — one in flight keeps the sweep
 * idempotent and the write volume flat. Under `BRIEF_FAKE_MODEL=1` (e2e/dev) the model plans run
 * through the direct fake generator instead and the SDK is never touched.
 */
export async function submitBriefBatch({ limit = BRIEF_BATCH_DEFAULT_LIMIT }: { limit?: number } = {}): Promise<SubmitBriefBatchSummary> {
    if (!isFakeModel() && (await briefBatchesDAO.findProcessing()).length > 0) {
        return { submitted: 0, skipped: 0, inFlight: true };
    }
    const { skips, models } = partitionPlans(await findBriefTargets(limit));
    const skipped = await executePlansSerially(skips, BRIEF_BATCH_DEVICE_ID);
    if (isFakeModel()) {
        return { submitted: await executePlansSerially(models, BRIEF_BATCH_DEVICE_ID), skipped, inFlight: false, fake: true };
    }
    if (models.length === 0) {
        return { submitted: 0, skipped, inFlight: false };
    }
    const batchId = await createBatch(models);
    console.info(`${LOG_PREFIX} submitted batch=${batchId} requests=${models.length} skipped=${skipped}`);
    return { submitted: models.length, skipped, inFlight: false, batchId };
}

// ── harvest ────────────────────────────────────────────────────────────────

type BatchResult = Anthropic.Messages.Batches.MessageBatchIndividualResponse;

function isPermanentError(result: Extract<BatchResult['result'], { type: 'errored' }>): boolean {
    return result.error.error.type === 'invalid_request_error';
}

/** Writes one succeeded result through the CAS writer; the row the request was built from anchors the check. */
async function writeSucceeded(request: BriefBatchRequestInterface, message: Anthropic.Message): Promise<keyof BriefBatchResultCounts> {
    const text = parseBriefResponse(message);
    const written = await writeModelBrief({
        userId: request.user,
        itemId: request.itemId,
        sourceHash: request.sourceHash,
        generated: { text, model: BRIEF_MODEL },
        deviceId: BRIEF_BATCH_DEVICE_ID,
    });
    if (written.outcome === 'discarded_stale') {
        return 'discardedStale';
    }
    return written.outcome === 'pinned' ? 'pinned' : 'written';
}

/**
 * A `succeeded` line that cannot be written counts as `errored`, whether the payload was unusable
 * (refusal, malformed JSON) or the write itself failed (a Mongo hiccup). NOTHING thrown per result
 * may escape the stream: an aborted harvest leaves the batch `processing`, and one deterministic
 * bad row would then block every submit until the 26 h expiry — with each retry re-streaming and
 * re-writing the rows before it (noop churn). The target stays stale and is resubmitted later.
 */
async function harvestSucceeded(request: BriefBatchRequestInterface, message: Anthropic.Message): Promise<keyof BriefBatchResultCounts> {
    try {
        return await writeSucceeded(request, message);
    } catch (err) {
        const detail = err instanceof BriefGenerationError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
        console.warn(`${LOG_PREFIX} item=${request.itemId} result not written: ${detail}`);
        return 'errored';
    }
}

/**
 * Routes one result line. Only `succeeded` writes; every other outcome is tallied and left for the
 * next sweep to reselect (the target is still stale). A permanent `invalid_request_error` is
 * logged loudly — it means we built a bad request and resubmitting will not help.
 */
async function harvestResult(line: BatchResult, request: BriefBatchRequestInterface): Promise<(keyof BriefBatchResultCounts)[]> {
    const { result } = line;
    if (result.type === 'succeeded') {
        return ['succeeded', await harvestSucceeded(request, result.message)];
    }
    if (result.type === 'errored') {
        const level = isPermanentError(result) ? 'error' : 'warn';
        console[level](`${LOG_PREFIX} item=${request.itemId} ${result.error.error.type}: ${result.error.error.message}`);
        return ['errored'];
    }
    return [result.type];
}

async function tallyResults(batchId: string, requests: Map<string, BriefBatchRequestInterface>): Promise<BriefBatchResultCounts> {
    const counts = emptyCounts();
    // Unknown ids are summarised once after the stream: a batch whose request rows were reaped
    // (TTL) would otherwise log one line per result.
    let unknown = 0;
    for await (const line of await getAnthropicClient().messages.batches.results(batchId)) {
        const request = requests.get(line.custom_id);
        if (!request) {
            unknown += 1;
            continue;
        }
        for (const key of await harvestResult(line, request)) {
            counts[key] += 1;
        }
    }
    if (unknown > 0) {
        console.warn(`${LOG_PREFIX} batch=${batchId} ignored ${unknown} result(s) with no matching request row`);
    }
    return counts;
}

async function harvestEndedBatch(row: BriefBatchInterface): Promise<BriefBatchResultCounts> {
    const requests = await briefBatchRequestsDAO.findByBatch(row._id);
    const counts = await tallyResults(row._id, requests);
    await briefBatchesDAO.markHarvested(row._id, dayjs().toISOString(), counts);
    await briefBatchRequestsDAO.deleteByBatch(row._id);
    console.info(`${LOG_PREFIX} harvested batch=${row._id} ${JSON.stringify(counts)}`);
    return counts;
}

function isPastExpiry(row: BriefBatchInterface, now: dayjs.Dayjs): boolean {
    return now.diff(dayjs(row.createdTs), 'hour', true) >= BRIEF_BATCH_EXPIRY_HOURS;
}

type BatchVerdict = { status: 'harvested'; counts: BriefBatchResultCounts } | { status: 'pending' | 'expired' | 'failed' | 'errors' };

async function expireBatch(row: BriefBatchInterface): Promise<BatchVerdict> {
    console.error(`${LOG_PREFIX} batch=${row._id} still processing after ${BRIEF_BATCH_EXPIRY_HOURS} h — marking expired`);
    await briefBatchesDAO.markTerminal(row._id, 'expired');
    await briefBatchRequestsDAO.deleteByBatch(row._id);
    return { status: 'expired' };
}

async function harvestBatch(row: BriefBatchInterface, now: dayjs.Dayjs): Promise<BatchVerdict> {
    const batch = await getAnthropicClient().messages.batches.retrieve(row._id);
    if (batch.processing_status === 'ended') {
        return { status: 'harvested', counts: await harvestEndedBatch(row) };
    }
    return isPastExpiry(row, now) ? expireBatch(row) : { status: 'pending' };
}

/** Isolates one batch's failure so the others still harvest; a vanished batch is terminal, anything else is retried next sweep. */
async function harvestBatchSafely(row: BriefBatchInterface, now: dayjs.Dayjs): Promise<BatchVerdict> {
    try {
        return await harvestBatch(row, now);
    } catch (err) {
        if (err instanceof Anthropic.NotFoundError) {
            console.error(`${LOG_PREFIX} batch=${row._id} unknown to Anthropic — marking failed`);
            await briefBatchesDAO.markTerminal(row._id, 'failed');
            await briefBatchRequestsDAO.deleteByBatch(row._id);
            return { status: 'failed' };
        }
        console.error(`${LOG_PREFIX} batch=${row._id} harvest error (will retry): ${err instanceof Error ? err.message : String(err)}`);
        return { status: 'errors' };
    }
}

function foldVerdict(summary: HarvestBriefBatchesSummary, verdict: BatchVerdict): HarvestBriefBatchesSummary {
    if (verdict.status === 'harvested') {
        return { ...summary, harvested: summary.harvested + 1, resultCounts: addCounts(summary.resultCounts, verdict.counts) };
    }
    return { ...summary, [verdict.status]: summary[verdict.status] + 1 };
}

/**
 * Drains every `processing` batch: ended ones are streamed into CAS writes and marked
 * `harvested`; one still running past 26 h is marked `expired`. Batches are handled one after
 * another — each harvest is a stream of writes, and the sweep runs on a single instance.
 */
export async function harvestBriefBatches(): Promise<HarvestBriefBatchesSummary> {
    const now = dayjs();
    const empty: HarvestBriefBatchesSummary = { harvested: 0, pending: 0, expired: 0, failed: 0, errors: 0, resultCounts: emptyCounts() };
    // Sequential fold: verdicts depend on I/O that must not overlap, so a reduce over promises is avoided.
    let summary = empty;
    for (const row of await briefBatchesDAO.findProcessing()) {
        summary = foldVerdict(summary, await harvestBatchSafely(row, now));
    }
    return summary;
}
