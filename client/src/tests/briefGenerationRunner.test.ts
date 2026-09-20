/**
 * `runBriefGeneration` — the plain orchestration behind the Generate button: flush the editor's
 * text first, call the endpoint, land the returned row, and decide what to tell the user.
 */
import { describe, expect, it, vi } from 'vitest';
import { BriefApiError, type GenerateBriefResult, type ServerItemBriefSnapshot } from '../api/briefApi';
import { type BriefRunPorts, runBriefGeneration } from '../components/itemEditor/briefGenerationRunner';

const ROW: ServerItemBriefSnapshot = {
    _id: 'item-1',
    itemId: 'item-1',
    user: 'user-1',
    text: '[fake] Generated.',
    origin: 'model',
    sourceHash: 'h1',
    generatedTs: '2026-09-20T10:05:00.000Z',
    createdTs: '2026-09-20T10:00:00.000Z',
    updatedTs: '2026-09-20T10:05:00.000Z',
};

function makePorts(generate: BriefRunPorts['generate']) {
    const calls: string[] = [];
    const ports: BriefRunPorts = {
        flushItemText: vi.fn(async () => {
            calls.push('flush');
        }),
        generate: vi.fn(async (force: boolean) => {
            calls.push('generate');
            return generate(force);
        }),
        store: vi.fn(async () => {
            calls.push('store');
        }),
    };
    return { ports, calls };
}

const resolveWith = (result: GenerateBriefResult) => () => Promise.resolve(result);
const rejectWith = (err: unknown) => () => Promise.reject(err);

describe('runBriefGeneration', () => {
    it('flushes the editor text BEFORE calling the endpoint, then stores the written row silently', async () => {
        const { ports, calls } = makePorts(resolveWith({ outcome: 'written', brief: ROW }));
        expect(await runBriefGeneration(false, ports)).toEqual({ kind: 'silent' });
        expect(calls).toEqual(['flush', 'generate', 'store']);
        expect(ports.store).toHaveBeenCalledWith(ROW);
        expect(ports.generate).toHaveBeenCalledWith(false);
    });

    it('passes force through to the endpoint', async () => {
        const { ports } = makePorts(resolveWith({ outcome: 'written', brief: ROW }));
        await runBriefGeneration(true, ports);
        expect(ports.generate).toHaveBeenCalledWith(true);
    });

    it('stores the text: null row for a skipped outcome and reports the too-short notice', async () => {
        const skippedRow = { ...ROW, text: null, origin: 'skipped' as const };
        const { ports } = makePorts(resolveWith({ outcome: 'skipped', brief: skippedRow }));
        expect(await runBriefGeneration(false, ports)).toEqual({ kind: 'notice', text: 'Notes are too short for a brief — the title already says it' });
        expect(ports.store).toHaveBeenCalledWith(skippedRow);
    });

    it('stores nothing for discarded_stale and asks the user to retry', async () => {
        const { ports } = makePorts(resolveWith({ outcome: 'discarded_stale', brief: null }));
        expect(await runBriefGeneration(false, ports)).toEqual({ kind: 'notice', text: 'Notes changed while generating; try again' });
        expect(ports.store).not.toHaveBeenCalled();
    });

    it('turns a 409 brief_pinned refusal into the confirm gate without storing anything', async () => {
        const { ports } = makePorts(rejectWith(new BriefApiError('pinned', { status: 409, code: 'brief_pinned' })));
        expect(await runBriefGeneration(false, ports)).toEqual({ kind: 'confirm' });
        expect(ports.store).not.toHaveBeenCalled();
    });

    it('maps 429 / 503 / network throws to their notices', async () => {
        const rateLimited = makePorts(rejectWith(new BriefApiError('x', { status: 429, code: 'rate_limited', retryAfterSeconds: 30 })));
        expect(await runBriefGeneration(false, rateLimited.ports)).toEqual({ kind: 'notice', text: 'Too many brief generations, try again in 30 seconds' });
        const unavailable = makePorts(rejectWith(new BriefApiError('x', { status: 503, code: 'agent_unavailable' })));
        expect(await runBriefGeneration(false, unavailable.ports)).toEqual({ kind: 'notice', text: 'AI brief generation is not configured on this server' });
        const network = makePorts(rejectWith(new TypeError('Failed to fetch')));
        expect(await runBriefGeneration(false, network.ports)).toEqual({ kind: 'notice', text: 'Could not generate a brief' });
    });

    it('a failing flush never reaches the endpoint and reads as a generic failure', async () => {
        const { ports } = makePorts(resolveWith({ outcome: 'written', brief: ROW }));
        vi.mocked(ports.flushItemText).mockRejectedValueOnce(new Error('idb closed'));
        expect(await runBriefGeneration(false, ports)).toEqual({ kind: 'notice', text: 'Could not generate a brief' });
        expect(ports.generate).not.toHaveBeenCalled();
    });
});
