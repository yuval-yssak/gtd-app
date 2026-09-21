import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dayjs from 'dayjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { findMockingTestFiles } from './mockingTestFiles.js';

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * Guards the invariants src/tests/setup.ts + vitest.config.ts establish for every file. If one of
 * these fails, the suite is no longer hermetic or no longer isolated per file — see the comments in
 * setup.ts for why each exists.
 */
describe('test harness', () => {
    beforeAll(async () => {
        await loadDataAccess('gtd_test_harness');
    });

    afterAll(async () => {
        await closeDataAccess();
    });

    it('names the database after the run, the worker and the file', () => {
        const fileId = createHash('sha1')
            .update(expect.getState().testPath ?? '')
            .digest('hex')
            .slice(0, 8);
        expect(process.env.TEST_FILE_ID).toBe(fileId);
        expect(db.databaseName).toBe(`gtd_test_harness_p${process.ppid}_w${process.env.VITEST_POOL_ID}_f${fileId}`);
        expect(db.databaseName.length).toBeLessThanOrEqual(63); // MongoDB's database-name limit
    });

    it('routes every vi.mock caller, at any depth, to the isolated project', () => {
        // Independent walk (not the detector's own code) so a regression in findMockingTestFiles —
        // e.g. dropping `recursive` — is caught here rather than as a mock leaking into another file.
        const walk = (dir: string): string[] =>
            readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) return walk(path);
                return entry.name.endsWith('.test.ts') && readFileSync(path, 'utf8').includes('vi.mock(') ? [path] : [];
            });
        expect(findMockingTestFiles(TESTS_DIR).sort()).toEqual(walk(TESTS_DIR).sort());
        expect(findMockingTestFiles(TESTS_DIR).length).toBeGreaterThan(0);
    });

    it('strips CALENDAR_WEBHOOK_URL so webhook registration stays opt-in per test', () => {
        expect(process.env.CALENDAR_WEBHOOK_URL).toBeUndefined();
    });

    it('aborts outbound http/https requests', () => {
        for (const request of [http.request, https.request]) {
            expect(() => request('https://oauth2.googleapis.com/token')).toThrowError(expect.objectContaining({ name: 'AbortError' }));
        }
    });

    it('fails an unmocked Google API call fast, without gaxios retry backoff', async () => {
        const now = dayjs().toISOString();
        const provider = new GoogleCalendarProvider({
            _id: 'int-harness',
            user: 'user-harness',
            provider: 'google',
            accessToken: 'at',
            refreshToken: 'rt',
            tokenExpiry: now,
            calendarId: 'primary',
            createdTs: now,
            updatedTs: now,
        });
        const startedAt = performance.now();
        await expect(provider.getEvent('primary', 'evt-1')).rejects.toMatchObject({ code: 'AbortError' });
        // gaxios retries transport failures twice with ~100 ms+ backoff; an aborted request skips that.
        expect(performance.now() - startedAt).toBeLessThan(500);
    });
});
