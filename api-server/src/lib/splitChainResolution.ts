import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import rrule from 'rrule';
import type { CalendarProvider, GCalEvent } from '../calendarProviders/CalendarProvider.js';
import type { RoutineInterface } from '../types/entities.js';
import { normalizeMasterEventId } from './routineItemRegeneration.js';
import { extractUntilFromRrule } from './rruleHelpers.js';
import { hasAtLeastOne } from './typeUtils.js';

dayjs.extend(utc);

// rrule@2.8.1 ships CJS as `main`; default-import + destructure works across Node ESM/Vitest.
const { RRule } = rrule;

/**
 * Split-chain resolution: follow a GCal "this and all following" split chain from any link to its
 * TERMINAL link.
 *
 * Each GCal split caps the current master with UNTIL and mints an open-ended continuation whose id
 * is `<bareId>_R<anchor>` — the anchor being the continuation's first-occurrence datetime. Repeated
 * splits grow a chain of masters that all normalize (`normalizeMasterEventId`) to ONE bare id, each
 * link's rrule capped except (possibly) the last. A routine anchored at an earlier link is blind to
 * everything the terminal knows: its pushback PATCHes a dead master and, when the terminal itself
 * expires, the routine keeps generating phantom items forever.
 *
 * Google exposes no lineage API for these chains, so continuations are DISCOVERED: instances
 * returned by a windowed `listEvents` (singleEvents expansion) carry `recurringEventId` in the raw
 * `_R<anchor>` form, which both names the next link and orders it (anchors are chronological). A
 * link's own end (`UNTIL`, or the last COUNT occurrence) tells us where to aim the window.
 */

/** Only the two read methods the chain walk needs — keeps tests to a tiny fake. */
export type ChainProvider = Pick<CalendarProvider, 'getEvent' | 'listEvents'>;

/**
 * Hard cap on chain hops — a defensive bound, not an expected shape. Real chains grow by explicit
 * user splits (staging's worst case was ~4 links); anchors strictly increase per hop so a true
 * cycle is impossible, but a pathological id set must not turn the walk into a runaway loop of
 * provider calls.
 */
const MAX_CHAIN_HOPS = 10;

/**
 * How far past a link's end the continuation search looks. Must exceed the largest plausible gap
 * between a link's cap and its continuation's first occurrence — a quarterly rule
 * (FREQ=MONTHLY;INTERVAL=3, a live staging shape) can put that first occurrence ~3 months out;
 * 400 days also covers yearly-ish gaps with a margin.
 */
const CONTINUATION_LOOKAHEAD_DAYS = 400;

/** Symmetric window half-width used when a link is gone (404/cancelled) and offers no end to aim from. */
const GONE_LINK_WINDOW_DAYS = 400;

/**
 * A COUNT beyond this is treated as an open series rather than expanded — expanding it just to find
 * its last occurrence would be pathological, and "open" errs toward keeping the routine alive.
 */
const MAX_EXPANDABLE_COUNT = 5000;

/** One resolved chain link: the raw id GCal reports it under plus its live rrule. */
export interface ChainTerminal {
    /** Raw id as GCal reports it — `_R<anchor>`-suffixed for every link after the base. */
    rawId: string;
    rrule: string;
    event: GCalEvent;
}

export type SplitChainResolution =
    | { status: 'live'; terminal: ChainTerminal; hops: number }
    /** Every link's end has passed and no continuation exists — the series is genuinely over. */
    | { status: 'over'; terminal: ChainTerminal & { endedAt: string }; hops: number }
    /** Walk could not positively identify a terminal (gone link with no discoverable continuation, missing RRULE, hop cap). Callers must not act. */
    | { status: 'unresolved'; reason: string; hops: number };

/**
 * Per-routine chain resolution seam: `null` when the routine's integration/config offers no usable
 * provider (revoked, unlinked). The sync doctor takes one of these so its chain checks stay
 * provider-agnostic and unit-testable.
 */
export type RoutineChainResolver = (routine: RoutineInterface) => Promise<SplitChainResolution | null>;

/** The `<anchor>` portion of a rebased `_R` id, or '' for a bare id. Lexicographic order is chronological. */
export function rebasedAnchorOf(rawEventId: string): string {
    const match = rawEventId.match(/_R(\d{8}(?:T\d{6}Z?)?)$/);
    return match?.[1] ?? '';
}

/** True when the rrule's UNTIL is the bare `YYYYMMDD` form (an all-day series) rather than a datetime. */
function isDateOnlyUntil(rruleStr: string): boolean {
    return /(?:^|;)UNTIL=\d{8}(?:;|$)/.test(rruleStr);
}

/** Parses a COUNT=<n> clause out of an rrule string, or null when absent/malformed. */
function parseCountClause(rruleStr: string): number | null {
    const match = rruleStr.toUpperCase().match(/(?:^|;)COUNT=(\d+)/);
    return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

/**
 * ISO datetime after which a series produces no further occurrences: the UNTIL cutoff, or the last
 * COUNT-bounded occurrence (expanded from the master's first-occurrence DTSTART). `null` means the
 * series is open-ended. An over-large COUNT is treated as open — see `MAX_EXPANDABLE_COUNT`.
 * Exported for unit testing.
 */
export function effectiveSeriesEndIso(rruleStr: string, dtstartIso: string): string | null {
    const until = extractUntilFromRrule(rruleStr);
    if (until) {
        // A date-only UNTIL (all-day series) is INCLUSIVE of that whole day (RFC 5545), but
        // `extractUntilFromRrule` parses it to UTC midnight. Push it to end-of-day so the series
        // still reads as live on its last day and the dead-chain item sweep (`timeStart > endedAt`)
        // cannot trash the occurrence that falls ON the cap date.
        return isDateOnlyUntil(rruleStr) ? dayjs.utc(until).endOf('day').toISOString() : until;
    }
    const count = parseCountClause(rruleStr);
    if (count === null || count > MAX_EXPANDABLE_COUNT) {
        return null;
    }
    try {
        // DTSTART embedded in the string (not spread via options) so byhour/byminute don't inherit the
        // wall-clock time — mirrors `parseRrule` in rruleHelpers.ts. dayjs.utc handles both the timed
        // ISO and the bare `YYYY-MM-DD` form an all-day master reports. COUNT=5000 daily expands in
        // ~23ms, so the MAX_EXPANDABLE_COUNT bound is comfortable.
        const dtStartStr = `${dayjs.utc(dtstartIso).format('YYYYMMDDTHHmmss')}Z`;
        const rule = RRule.fromString(`DTSTART:${dtStartStr}\nRRULE:${rruleStr}`);
        const occurrences = rule.all();
        const last = occurrences[occurrences.length - 1];
        // COUNT >= 1 always yields at least DTSTART itself; the fallback guards a COUNT=0 degenerate.
        return last ? last.toISOString() : dtstartIso;
    } catch {
        // RRule.fromString THROWS on malformed rules. Treat the series as open — erring toward "live"
        // keeps the routine alive (no destructive retire) and must never 500 a caller like the
        // sync-doctor endpoint over one corrupt event.
        return null;
    }
}

/** Extracts the RRULE string from a GCal recurrence array, stripping the "RRULE:" prefix. */
function extractRruleFromEvent(event: GCalEvent): string | null {
    const rruleLine = (event.recurrence ?? []).find((line) => line.startsWith('RRULE:'));
    return rruleLine ? rruleLine.replace(/^RRULE:/, '') : null;
}

/** Where to look for the link after `afterRawId` on series `bareId`: the time window its instances would fall in. */
interface ContinuationSearch {
    calendarId: string;
    bareId: string;
    afterRawId: string;
    window: { start: string; end: string };
}

/**
 * Discover the furthest continuation link visible in the search window: instances whose
 * `recurringEventId` normalizes to `bareId` and whose anchor sorts strictly after `afterRawId`'s.
 * Returns the raw id with the MAX anchor (skipping intermediate links costs nothing — the walk
 * resumes from whatever it lands on), or null when the window shows none.
 */
async function discoverContinuation(provider: ChainProvider, search: ContinuationSearch): Promise<string | null> {
    const events = await provider.listEvents(search.calendarId, search.window.start, search.window.end);
    const afterAnchor = rebasedAnchorOf(search.afterRawId);
    const continuations = events
        .map((event) => event.recurringEventId)
        .filter((id): id is string => typeof id === 'string')
        .map((id) => ({ id, anchor: rebasedAnchorOf(id) }))
        .filter(({ id, anchor }) => normalizeMasterEventId(id) === search.bareId && anchor > afterAnchor);
    if (!hasAtLeastOne(continuations)) {
        return null;
    }
    return continuations.reduce((max, candidate) => (candidate.anchor > max.anchor ? candidate : max)).id;
}

/** One fetched-and-classified chain link. `noRrule` covers a confirmed master this walk cannot reason about. */
type ResolvedLink =
    | { kind: 'gone' }
    | { kind: 'noRrule' }
    | { kind: 'live'; terminal: ChainTerminal }
    | { kind: 'ended'; terminal: ChainTerminal & { endedAt: string } };

/**
 * Fetch one chain link and classify it. A link is `live` when its series has no end or the end is
 * at/after `now` — a FUTURE cap still owns the present, and following its continuation early would
 * regenerate near-term items on the successor's schedule.
 */
async function resolveLink(provider: ChainProvider, calendarId: string, rawId: string, nowIso: string): Promise<ResolvedLink> {
    const event = await provider.getEvent(calendarId, rawId);
    if (event === null || event.status === 'cancelled') {
        return { kind: 'gone' };
    }
    const rrule = extractRruleFromEvent(event);
    if (rrule === null) {
        return { kind: 'noRrule' };
    }
    const endedAt = effectiveSeriesEndIso(rrule, event.timeStart);
    if (endedAt === null || !dayjs(endedAt).isBefore(dayjs(nowIso))) {
        return { kind: 'live', terminal: { rawId, rrule, event } };
    }
    return { kind: 'ended', terminal: { rawId, rrule, event, endedAt } };
}

/** Continuation window for a link whose end is known: a day of slack behind it, the lookahead ahead of it. */
function windowFromLinkEnd(endIso: string): { start: string; end: string } {
    return {
        start: dayjs.utc(endIso).subtract(1, 'day').toISOString(),
        end: dayjs.utc(endIso).add(CONTINUATION_LOOKAHEAD_DAYS, 'day').toISOString(),
    };
}

/** Wide symmetric window around `now` for a gone link that offers no end to aim the search from. */
function windowAroundNow(nowIso: string): { start: string; end: string } {
    return {
        start: dayjs.utc(nowIso).subtract(GONE_LINK_WINDOW_DAYS, 'day').toISOString(),
        end: dayjs.utc(nowIso).add(GONE_LINK_WINDOW_DAYS, 'day').toISOString(),
    };
}

/**
 * Walk a split chain from `startRawId` to its terminal link.
 *
 * Per hop: fetch and classify the link (`resolveLink`), then either stop or follow a discovered
 * continuation. A past-ended link aims the continuation search just past its end; a gone/cancelled
 * link searches a wide window around `now`. No continuation found means the chain is `over` (when
 * the last link is real) or `unresolved` (when it is gone — a bare 404 with no discovered tail is
 * owned by the cancellation/vanish machinery, not this walk).
 *
 * Cycles are impossible by construction — `discoverContinuation` only moves to strictly-greater
 * anchors — so the hop cap alone bounds a pathological id set.
 */
export async function resolveSplitChainTerminal(
    provider: ChainProvider,
    calendarId: string,
    startRawId: string,
    nowIso: string,
): Promise<SplitChainResolution> {
    const bareId = normalizeMasterEventId(startRawId);
    // `let` + loop: the walk is inherently iterative (each hop's target comes from the previous
    // hop's provider responses) — recursion would just hide the same mutation in call frames.
    let currentId = startRawId;
    for (let hops = 0; hops < MAX_CHAIN_HOPS; hops++) {
        const link = await resolveLink(provider, calendarId, currentId, nowIso);
        if (link.kind === 'noRrule') {
            return { status: 'unresolved', reason: `link ${currentId} has no RRULE`, hops };
        }
        if (link.kind === 'live') {
            return { status: 'live', terminal: link.terminal, hops };
        }
        const window = link.kind === 'ended' ? windowFromLinkEnd(link.terminal.endedAt) : windowAroundNow(nowIso);
        const next = await discoverContinuation(provider, { calendarId, bareId, afterRawId: currentId, window });
        if (next === null) {
            return link.kind === 'ended'
                ? { status: 'over', terminal: link.terminal, hops }
                : { status: 'unresolved', reason: `link ${currentId} is gone with no discoverable continuation`, hops };
        }
        currentId = next;
    }
    return { status: 'unresolved', reason: `hop cap (${MAX_CHAIN_HOPS}) exceeded`, hops: MAX_CHAIN_HOPS };
}
