import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Reporter, TestCase, TestModule } from 'vitest/node';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = resolve(__dirname, '../reports');

interface Row {
    scenario: string;
    section: string;
    title: string;
    status: 'pass' | 'fail' | 'skip';
    durationMs: number;
    errorMessage?: string;
    artifacts?: string[];
    /** True for tests declared with it.skip — distinct from skipped-due-to-setup-failure. */
    intentionalSkip?: boolean;
}

/**
 * Custom vitest reporter that emits a human-readable markdown audit report.
 *
 * Scenario IDs are parsed from the first token of each test name, e.g.
 * `it('A1 — create routine in app, link to GCal', ...)` → scenario "A1".
 *
 * Extra context can be attached to a test via the global `auditAnnotate(...)`
 * helper (see harness/annotate.ts); annotations are picked up via the
 * `onTestCaseResult` hook and surfaced in the report's Notes column.
 */
export default class AuditReporter implements Reporter {
    private rows: Row[] = [];
    private startedAt = new Date();

    onTestModuleEnd(module: TestModule): void {
        // If a beforeAll / suite-level hook threw, vitest attaches the error to the
        // enclosing suite, not the module. Walk the suites first and surface any
        // hook errors onto the tests they contain — otherwise those tests appear as
        // ⊘ skip with no explanation.
        const suiteErrors = new Map<string, string>();
        for (const suite of module.children.allSuites()) {
            const firstErr = suite.errors()[0]?.message?.split('\n')[0];
            if (firstErr) {
                for (const t of suite.children.allTests()) {
                    suiteErrors.set(t.fullName, firstErr);
                }
            }
        }
        for (const test of module.children.allTests()) {
            const row = this.rowFromTest(test);
            // Only promote skip→fail when it wasn't an intentional it.skip declaration.
            if (row.status === 'skip' && !row.intentionalSkip && suiteErrors.has(test.fullName)) {
                row.status = 'fail';
                row.errorMessage = `setup failed: ${suiteErrors.get(test.fullName)}`;
            }
            this.rows.push(row);
        }
    }

    onTestRunEnd(): void {
        mkdirSync(REPORTS_DIR, { recursive: true });
        const stamp = this.startedAt.toISOString().replace(/[:.]/g, '-');
        const mdPath = resolve(REPORTS_DIR, `sync-audit-${stamp}.md`);
        writeFileSync(mdPath, this.render());
        // eslint-disable-next-line no-console -- intentional user-facing output
        console.log(`\n📄 Audit report: ${mdPath}\n`);
    }

    private rowFromTest(test: TestCase): Row {
        const fullName = test.name;
        const scenarioMatch = fullName.match(/^([A-Z]\d+[a-z]?)\b/);
        const scenario = scenarioMatch?.[1] ?? '?';
        const section = scenario[0] ?? '?';
        const title = fullName.replace(/^[A-Z]\d+[a-z]?\s*[—-]\s*/, '');
        const result = test.result();
        const status: Row['status'] = result.state === 'passed' ? 'pass' : result.state === 'skipped' ? 'skip' : 'fail';
        const errors = 'errors' in result ? result.errors : undefined;
        const firstError = errors?.[0]?.message;
        const durationMs = Math.round(test.diagnostic()?.duration ?? 0);
        // options.mode === 'skip' means the test was declared with it.skip (intentional).
        // task.mode === 'skip' is always set for anything that didn't run and doesn't distinguish
        // intentional from setup-failure skips.
        const declared = (test as unknown as { options?: { mode?: string } }).options?.mode;
        const mode = declared;
        return {
            scenario,
            section,
            title,
            status,
            durationMs,
            ...(firstError ? { errorMessage: firstError.split('\n')[0] } : {}),
            ...(mode === 'skip' || mode === 'todo' ? { intentionalSkip: true } : {}),
        } as Row;
    }

    private render(): string {
        const ordered = [...this.rows].sort((a, b) => a.scenario.localeCompare(b.scenario, undefined, { numeric: true }));
        const passed = ordered.filter((r) => r.status === 'pass').length;
        const failed = ordered.filter((r) => r.status === 'fail').length;
        const skipped = ordered.filter((r) => r.status === 'skip').length;

        const lines: string[] = [];
        lines.push(`# Calendar Routine ↔ GCal Sync Audit`);
        lines.push('');
        lines.push(`Run started: ${this.startedAt.toISOString()}`);
        lines.push(`Total scenarios: ${ordered.length} — ✓ ${passed} pass · ✗ ${failed} fail · ⊘ ${skipped} skip`);
        lines.push('');
        lines.push('| # | Scenario | Status | Duration | Notes |');
        lines.push('|---|----------|--------|---------:|-------|');
        for (const r of ordered) {
            const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '⊘';
            const notes = r.errorMessage ? r.errorMessage.replace(/\|/g, '\\|').slice(0, 200) : '';
            lines.push(`| ${r.scenario} | ${r.title.replace(/\|/g, '\\|')} | ${icon} ${r.status} | ${r.durationMs} ms | ${notes} |`);
        }
        lines.push('');
        if (failed > 0) {
            lines.push('## Failures');
            lines.push('');
            for (const r of ordered.filter((x) => x.status === 'fail')) {
                lines.push(`### ${r.scenario} — ${r.title}`);
                lines.push('');
                lines.push('```');
                lines.push(r.errorMessage ?? '(no message)');
                lines.push('```');
                lines.push('');
            }
        }
        return lines.join('\n');
    }
}
